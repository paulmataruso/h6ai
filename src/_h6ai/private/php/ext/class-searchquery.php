<?php
declare(strict_types=1);

// What a user typed into the search box, parsed, plus the folding that names and queries share.
// See docs/SEARCH.md.
//
//   ubuntu iso         every word occurs in the name (any order)
//   "release notes"    exact text, spaces included
//   -draft             the name must not contain it
//   *.iso  img_20??*   wildcards over the whole name
//   re:^IMG_\d+        regular expression on the real name (slow path, time bounded)
//
// Matching is case and accent insensitive: both sides go through fold().
final class SearchQuery {
    // Part of the index fingerprint: bump whenever fold() changes its output.
    public const FOLD_VERSION = 1;
    public const MAX_INPUT_LENGTH = 1000;
    private const MAX_TERMS = 8;
    private const MIN_FRAGMENT = 3;

    // Precomposed Latin letters (after lower-casing) to plain ones. Combining marks of
    // decomposed (NFD) names are removed separately. No intl dependency, deterministic.
    private const FOLD_MAP = [
        'à' => 'a', 'á' => 'a', 'â' => 'a', 'ã' => 'a', 'ä' => 'a', 'å' => 'a', 'ā' => 'a', 'ă' => 'a', 'ą' => 'a',
        'æ' => 'ae', 'ç' => 'c', 'ć' => 'c', 'ĉ' => 'c', 'ċ' => 'c', 'č' => 'c', 'ď' => 'd', 'đ' => 'd', 'ð' => 'd',
        'è' => 'e', 'é' => 'e', 'ê' => 'e', 'ë' => 'e', 'ē' => 'e', 'ĕ' => 'e', 'ė' => 'e', 'ę' => 'e', 'ě' => 'e',
        'ĝ' => 'g', 'ğ' => 'g', 'ġ' => 'g', 'ģ' => 'g', 'ĥ' => 'h', 'ħ' => 'h',
        'ì' => 'i', 'í' => 'i', 'î' => 'i', 'ï' => 'i', 'ĩ' => 'i', 'ī' => 'i', 'ĭ' => 'i', 'į' => 'i', 'ı' => 'i',
        'ĳ' => 'ij', 'ĵ' => 'j', 'ķ' => 'k', 'ĺ' => 'l', 'ļ' => 'l', 'ľ' => 'l', 'ŀ' => 'l', 'ł' => 'l',
        'ñ' => 'n', 'ń' => 'n', 'ņ' => 'n', 'ň' => 'n', 'ŉ' => 'n',
        'ò' => 'o', 'ó' => 'o', 'ô' => 'o', 'õ' => 'o', 'ö' => 'o', 'ø' => 'o', 'ō' => 'o', 'ŏ' => 'o', 'ő' => 'o',
        'œ' => 'oe', 'ŕ' => 'r', 'ŗ' => 'r', 'ř' => 'r', 'ś' => 's', 'ŝ' => 's', 'ş' => 's', 'š' => 's', 'ș' => 's',
        'ſ' => 's', 'ß' => 'ss', 'ţ' => 't', 'ť' => 't', 'ŧ' => 't', 'ț' => 't', 'þ' => 'th',
        'ù' => 'u', 'ú' => 'u', 'û' => 'u', 'ü' => 'u', 'ũ' => 'u', 'ū' => 'u', 'ŭ' => 'u', 'ů' => 'u', 'ű' => 'u', 'ų' => 'u',
        'ŵ' => 'w', 'ý' => 'y', 'ÿ' => 'y', 'ŷ' => 'y', 'ź' => 'z', 'ż' => 'z', 'ž' => 'z'
    ];

    /** @var string[] folded literal terms, each must occur in the name */
    public array $terms = [];
    /** @var string[] folded terms that must not occur */
    public array $excludes = [];
    /** @var string[] folded wildcard patterns over the whole name (SQLite GLOB syntax) */
    public array $globs = [];
    /** @var string[] the same patterns as anchored PCRE (fallback walk) */
    public array $glob_res = [];
    public ?string $regex = null;
    public string $error = '';

    public static function fold(string $name): string {
        $folded = mb_strtolower($name, 'UTF-8');
        if (!preg_match('/[^\x00-\x7F]/', $folded)) {
            return $folded;
        }
        $folded = strtr($folded, SearchQuery::FOLD_MAP);
        return preg_replace('/\p{Mn}+/u', '', $folded) ?? $folded;
    }

    // Distinguishes fold() implementations (CLI and PHP-FPM must agree, see SearchIndex).
    public static function fold_signature(): string {
        return SearchQuery::FOLD_VERSION . ':' . substr(sha1(SearchQuery::fold("ÀÉÎõü Straße İSTANBUL Ǆ Ωμέγα E\u{301}")), 0, 12);
    }

    public static function parse(string $input, bool $advanced, bool $allow_regex): SearchQuery {
        $query = new SearchQuery();
        $input = trim($input);
        if ($input === '') {
            return $query;
        }
        if (strlen($input) > SearchQuery::MAX_INPUT_LENGTH) {
            $query->error = 'the search is too long';
            return $query;
        }

        if (!$advanced) {
            $query->terms[] = SearchQuery::fold($input);
            return $query;
        }

        if (str_starts_with($input, 're:')) {
            if (!$allow_regex) {
                $query->error = 'regular expressions are disabled';
                return $query;
            }
            $query->regex = substr($input, 3);
            if ($query->regex === '') {
                $query->regex = null;
            }
            return $query;
        }

        if (!preg_match_all('/(-?)"([^"]*)"?|(\S+)/u', $input, $matches, PREG_SET_ORDER)) {
            // not valid UTF-8: one literal term
            $query->terms[] = SearchQuery::fold($input);
            return $query;
        }
        foreach ($matches as $m) {
            if (isset($m[3]) && $m[3] !== '') {
                $token = $m[3];
                if (strlen($token) > 1 && $token[0] === '-') {
                    $query->add($query->excludes, SearchQuery::fold(substr($token, 1)));
                } elseif (strpbrk($token, '*?') !== false) {
                    $query->add_glob(SearchQuery::fold($token));
                } else {
                    $query->add($query->terms, SearchQuery::fold($token));
                }
            } elseif (trim($m[2]) !== '' && $m[1] === '-') {
                $query->add($query->excludes, SearchQuery::fold($m[2]));
            } elseif (trim($m[2]) !== '') {
                $query->add($query->terms, SearchQuery::fold($m[2]));
            }
        }
        if (count($query->terms) + count($query->excludes) + count($query->globs) > SearchQuery::MAX_TERMS) {
            $query->error = 'too many search words (at most ' . SearchQuery::MAX_TERMS . ')';
        }
        return $query;
    }

    private function add(array &$list, string $term): void {
        if ($term !== '' && !in_array($term, $list, true)) {
            $list[] = $term;
        }
    }

    private function add_glob(string $pattern): void {
        if (in_array($pattern, $this->globs, true) || trim($pattern, '*') === '') {
            return; // "*" alone matches everything: no restriction
        }
        // only * and ? are wildcards; [ and ] are literal in file names
        $glob = '';
        $re = '';
        foreach (mb_str_split($pattern) as $ch) {
            $glob .= match ($ch) { '[' => '[[]', ']' => '[]]', default => $ch };
            $re .= match ($ch) { '*' => '.*', '?' => '.', default => preg_quote($ch, '/') };
        }
        $this->globs[] = $glob;
        $this->glob_res[] = '/^' . $re . '$/su';
    }

    // Something to look for (exclusions alone match too much).
    public function is_empty(): bool {
        return !$this->terms && !$this->globs && $this->regex === null;
    }

    // Literal pieces of at least 3 characters, usable by the trigram index. Every matching name
    // contains all of them.
    public function fragments(): array {
        $out = [];
        foreach ($this->terms as $term) {
            if (mb_strlen($term) >= SearchQuery::MIN_FRAGMENT) {
                $out[] = $term;
            }
        }
        foreach ($this->globs as $glob) {
            $literal = str_replace(['[[]', '[]]'], ['[', ']'], $glob);
            foreach (preg_split('/[*?]+/', $literal) ?: [] as $run) {
                if (mb_strlen($run) >= SearchQuery::MIN_FRAGMENT) {
                    $out[] = $run;
                }
            }
        }
        return array_values(array_unique($out));
    }

    // The term ranking looks at: the first word, or the leading literal of the first pattern.
    public function rank_term(): string {
        if ($this->terms) {
            return $this->terms[0];
        }
        foreach ($this->globs as $glob) {
            $lead = preg_split('/[*?]/', str_replace(['[[]', '[]]'], ['[', ']'], $glob))[0] ?? '';
            if ($lead !== '') {
                return $lead;
            }
        }
        return '';
    }

    // FTS5 query: every fragment as a phrase (for the trigram tokenizer a phrase is a substring).
    public function fts_match(): string {
        return implode(' AND ', array_map(fn ($f) => '"' . str_replace('"', '""', $f) . '"', $this->fragments()));
    }

    // Same semantics in PHP, for the fallback walk and for checks outside SQL.
    public function matches_name(string $name, bool $ignorecase = true): bool {
        if ($this->regex !== null) {
            return @preg_match($this->regex_pattern($ignorecase), $name) === 1;
        }
        $key = SearchQuery::fold($name);
        foreach ($this->terms as $term) {
            if (!str_contains($key, $term)) {
                return false;
            }
        }
        foreach ($this->excludes as $term) {
            if (str_contains($key, $term)) {
                return false;
            }
        }
        foreach ($this->glob_res as $re) {
            if (@preg_match($re, $key) !== 1) {
                return false;
            }
        }
        return true;
    }

    public function regex_pattern(bool $ignorecase): string {
        return Util::wrap_pattern((string) $this->regex) . 'u' . ($ignorecase ? 'i' : '');
    }
}
