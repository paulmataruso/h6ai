<?php
/**
 * Page template for the index and the info page.
 * @var array $page module, title, site_name, head_meta, version, public_href, asset_href, index_href, nonce, skin, skins,
 *                  x_head_tags, fallback_mode, fallback_html
 */
// requested directly (drop-in installs run every .php file): nothing to render
if (!isset($page) || !is_array($page)) {
    http_response_code(404);
    exit;
}
$h = fn ($value) => Util::html($value);
// versioned: cacheable for a year (asset_href carries the version on drop-in installs)
$asset = fn ($path) => $h($page['asset_href'] . $path . '?v=' . rawurlencode($page['version']));
?>
<!DOCTYPE html>
<html lang="en" class="no-js" data-skin="<?= $h($page['skin']) ?>" data-site-skin="<?= $h($page['skin']) ?>">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <meta name="generator" content="h6ai <?= $h($page['version']) ?>">
    <?= $page['head_meta'] ?>

    <title><?= $h($page['title']) ?></title>
    <meta name="theme-color" content="#0d1117">
    <link rel="icon" href="<?= $h($page['public_href']) ?>images/favicon/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="<?= $h($page['public_href']) ?>images/favicon/favicon.ico" sizes="16x16 32x32 48x48">
    <link rel="apple-touch-icon" href="<?= $h($page['public_href']) ?>images/favicon/favicon-180.png">
    <script nonce="<?= $h($page['nonce']) ?>">
        (function (d) {
            // apply the visitor's own theme before first paint (no flash); otherwise the site
            // default rendered by the server stays
            var s = null, skins = <?= json_encode(array_values($page['skins'])) ?>;
            try { s = JSON.parse(localStorage.getItem('_h6ai') || '{}').skin; } catch (e) {}
            if (skins.indexOf(s) >= 0) { d.documentElement.setAttribute('data-skin', s); }
            d.documentElement.className = 'js';
        }(document));
    </script>
    <link rel="stylesheet" href="<?= $asset('css/styles.css') ?>">
<?php if (!$page['fallback_mode']) { ?>
    <script type="module" nonce="<?= $h($page['nonce']) ?>" src="<?= $asset('js/scripts.js') ?>" data-module="<?= $h($page['module']) ?>" data-api="<?= $h($page['index_href']) ?>"></script>
<?php } ?>
    <?= $page['x_head_tags'] ?>

</head>
<body id="root" class="<?= $h($page['module']) ?>">
<?php if ($page['module'] === 'info') { ?>
    <div id="content">
        <h1 id="header"><img src="<?= $h($page['public_href']) ?>images/brand/logo-mark.svg" alt="" width="32" height="32"> <?= $h($page['site_name']) ?></h1>
    </div>
<?php } else { ?>
    <div id="fallback-hints">
        <span class="fallback-brand"><img src="<?= $h($page['public_href']) ?>images/brand/logo-mark.svg" alt="" width="22" height="22"> <?= $h($page['site_name']) ?></span>
<?php if (!$page['fallback_mode']) { ?>
        <noscript><span class="noJsMsg">JavaScript is off, so this is the basic listing.</span></noscript>
<?php } ?>
        <span class="backlink">powered by h6ai <?= $h($page['version']) ?></span>
    </div>
    <div id="fallback"><?= $page['fallback_html'] ?></div>
<?php } ?>
</body>
</html>
