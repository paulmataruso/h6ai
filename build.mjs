#!/usr/bin/env node
// Build script for h6ai. Replaces the old ghu/webpack/babel/less/pug pipeline.
//
//   node build.mjs              production build into ./build/_h6ai
//   node build.mjs --dev        unminified, with sourcemaps
//   node build.mjs --watch      rebuild on change (implies nothing else)
//   node build.mjs --release    production build + build/h6ai-<version>.{zip,tar.gz} (installer bundle)

import {execFileSync} from 'node:child_process';
import {cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {watch} from 'node:fs';
import {dirname, join, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src', '_h6ai');
const BUILD = join(ROOT, 'build');
const DEST = join(BUILD, '_h6ai');

const args = new Set(process.argv.slice(2));
const DEV = args.has('--dev');
const RELEASE = args.has('--release');
const WATCH = args.has('--watch');

// Browsers released roughly in the last 4 years. Anything older gets the fallback mode.
const BROWSER_TARGETS = ['chrome100', 'firefox100', 'safari15.4', 'edge100'];

const git = (...gitArgs) => {
    try {
        return execFileSync('git', gitArgs, {cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore']}).toString().trim();
    } catch {
        return '';
    }
};

const getPkg = async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    if (!RELEASE) {
        const hash = git('rev-parse', '--short', 'HEAD');
        if (hash) {
            pkg.version += `+${hash}`;
        }
    }
    return pkg;
};

// Sources that are compiled rather than copied verbatim.
const isCompiledSource = path => {
    const rel = relative(SRC, path).split(sep).join('/');
    return rel === 'public/js' || rel.startsWith('public/js/') ||
        rel === 'public/css' || rel.startsWith('public/css/');
};

const copyStatic = async pkg => {
    await cp(SRC, DEST, {
        recursive: true,
        filter: src => !isCompiledSource(src)
    });

    const stamp = async (path, fn) => {
        const file = join(DEST, path);
        await writeFile(file, fn(await readFile(file, 'utf8')));
    };
    await stamp('public/index.php', txt => txt.replace('{{VERSION}}', pkg.version));

    for (const name of ['README.md', 'CHANGELOG.md', 'LICENSE', 'SECURITY.md']) {
        await cp(join(ROOT, name), join(DEST, name)).catch(() => {});
    }
};

const banner = pkg => `/* ${pkg.name} v${pkg.version} | MIT | based on h5ai by Lars Jung */`;

// lolight inserts a <style> element when imported. The page's CSP (rightly) blocks inline
// styles, which logged an error on every page; h6ai styles lolight's token classes itself
// (content.css), so load its source without that injection.
const lolightWithoutStyleInjection = {
    name: 'lolight-without-style-injection',
    setup(build) {
        build.onResolve({filter: /^lolight$/}, () => ({path: join(ROOT, 'node_modules', 'lolight', 'src', 'lolight.js'), namespace: 'lolight'}));
        build.onLoad({filter: /.*/, namespace: 'lolight'}, async args => {
            const source = await readFile(args.path, 'utf8');
            const patched = source.replace('head.insertBefore(style, head.firstChild);', '/* style injection removed by h6ai build */');
            if (patched === source) {
                throw new Error('lolight: style injection not found, check the plugin in build.mjs');
            }
            return {contents: patched, loader: 'js'};
        });
    }
};

const esbuildOptions = pkg => [
    {
        entryPoints: [join(SRC, 'public', 'js', 'scripts.js')],
        outfile: join(DEST, 'public', 'js', 'scripts.js'),
        bundle: true,
        format: 'esm',
        target: BROWSER_TARGETS,
        minify: !DEV,
        sourcemap: DEV ? 'linked' : false,
        legalComments: 'none',
        banner: {js: banner(pkg)},
        define: {H6AI_VERSION: JSON.stringify(pkg.version), global: 'globalThis'},
        plugins: [lolightWithoutStyleInjection],
        logLevel: 'warning'
    },
    {
        entryPoints: [join(SRC, 'public', 'css', 'styles.css')],
        outfile: join(DEST, 'public', 'css', 'styles.css'),
        bundle: true,
        target: BROWSER_TARGETS,
        minify: !DEV,
        sourcemap: DEV ? 'linked' : false,
        banner: {css: banner(pkg)},
        loader: {'.svg': 'dataurl'},
        logLevel: 'warning'
    }
];

const buildOnce = async () => {
    const started = Date.now();
    const pkg = await getPkg();
    await rm(DEST, {recursive: true, force: true});
    await mkdir(DEST, {recursive: true});
    await copyStatic(pkg);
    await Promise.all(esbuildOptions(pkg).map(opts => esbuild.build(opts)));
    console.log(`built ${pkg.name} v${pkg.version} in ${Date.now() - started} ms -> ${relative(ROOT, DEST)}`);
    return pkg;
};

// Release bundle h6ai-<version>/: the built _h6ai folder (copy it into a web root by hand), plus
// the installer (native or Docker) and the nginx/PHP configuration both share.
const RELEASE_FILES = ['install.sh', 'deploy', 'README.md', 'CHANGELOG.md', 'SECURITY.md', 'LICENSE',
    'docs/INSTALL.md', 'docs/DEPLOYMENT.md',
    // install.sh --docker builds the image from the bundle (Dockerfile stage "prebuilt")
    'Dockerfile', 'compose.yaml', '.dockerignore', '.env.example', 'docker'];

const release = async pkg => {
    const base = `${pkg.name}-${pkg.version}`;
    const stage = join(BUILD, base);
    await rm(stage, {recursive: true, force: true});
    await cp(DEST, join(stage, '_h6ai'), {recursive: true});
    for (const file of RELEASE_FILES) {
        await cp(join(ROOT, file), join(stage, file), {recursive: true});
    }
    await rm(join(BUILD, `${base}.tar.gz`), {force: true});
    await rm(join(BUILD, `${base}.zip`), {force: true});
    execFileSync('tar', ['-czf', `${base}.tar.gz`, '--owner=0', '--group=0', base], {cwd: BUILD, stdio: 'inherit'});
    try {
        execFileSync('zip', ['-qr9', `${base}.zip`, base], {cwd: BUILD, stdio: 'inherit'});
    } catch {
        console.warn('zip not available, only the .tar.gz was created');
    }
    await rm(stage, {recursive: true, force: true});
    console.log(`release packages written to ${relative(ROOT, BUILD)}/${base}.*`);
};

const main = async () => {
    const pkg = await buildOnce();

    if (RELEASE) {
        await release(pkg);
    }

    if (WATCH) {
        let timer = null;
        let running = Promise.resolve();
        const trigger = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                running = running.then(buildOnce).catch(err => console.error(err.message));
            }, 100);
        };
        watch(join(ROOT, 'src'), {recursive: true}, trigger);
        console.log('watching src/ for changes ...');
    }
};

main().catch(err => {
    console.error(err);
    process.exit(1);
});
