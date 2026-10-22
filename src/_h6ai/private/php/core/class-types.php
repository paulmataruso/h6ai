<?php
declare(strict_types=1);

// Server side mirror of the client's type detection (js/lib/core/types.js): glob patterns from
// types.json, case-insensitive, the last matching type wins.
final class Types {
    private array $regexps = [];

    public function __construct(array $types) {
        foreach ($types as $type => $patterns) {
            if (!is_string($type) || !is_array($patterns)) {
                continue;
            }
            $parts = [];
            foreach ($patterns as $pattern) {
                if (is_string($pattern)) {
                    $parts[] = '(' . str_replace('\\*', '.*', preg_quote($pattern, '@')) . ')';
                }
            }
            if ($parts) {
                $this->regexps[$type] = '@^(' . implode('|', $parts) . ')$@i';
            }
        }
    }

    public function get_type(string $name): string {
        $result = 'file';
        foreach ($this->regexps as $type => $re) {
            if (preg_match($re, $name)) {
                $result = $type;
            }
        }
        return $result;
    }
}
