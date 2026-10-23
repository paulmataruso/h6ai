#!/usr/bin/env node
// Build script for h6ai. Replaces the old ghu/webpack/babel/less/pug pipeline.
//
//   node build.mjs              production build into ./build/_h6ai
//   node build.mjs --dev        unminified, with sourcemaps
//   node build.mjs --watch      rebuild on change (implies nothing else)
//   node build.mjs --release    production build + build/h6ai-<version>.{zip,tar.gz} (installer bundle)
//                               and build/h6ai-<version>-dropin.{zip,tar.gz} (just _h6ai, for a web root)

import {execFileSync} from 'node:child_process';
import {cp, lstat, mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {watch} from 'node:fs';
import {dirname, join, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deflateRawSync} from 'node:zlib';
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
    // the drop-in zip is just _h6ai: its guide travels inside
    await cp(join(ROOT, 'docs', 'install', 'dropin.md'), join(DEST, 'INSTALL.md')).catch(() => {});
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

// --- zip without an external tool (drop-in users mostly want a .zip) -------------------------

const CRC_TABLE = Uint32Array.from({length: 256}, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
});
const crc32 = buf => {
    let c = 0xFFFFFFFF;
    for (const byte of buf) {
        c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
};

const listTree = async (dir, prefix) => {
    const out = [];
    for (const entry of (await readdir(dir, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(dir, entry.name);
        const name = `${prefix}/${entry.name}`;
        const {mode} = await lstat(path);
        if (entry.isDirectory()) {
            out.push({name: name + '/', mode, data: null}, ...await listTree(path, name));
        } else if (entry.isFile()) {
            out.push({name, mode, data: await readFile(path)});
        }
    }
    return out;
};

// Writes <dir> as <prefix>/... into a zip file. Unix modes are kept (install.sh stays executable).
const writeZip = async (dir, prefix, file) => {
    const entries = [{name: prefix + '/', mode: 0o40755, data: null}, ...await listTree(dir, prefix)];
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const raw = entry.data || Buffer.alloc(0);
        const packed = entry.data ? deflateRawSync(raw, {level: 9}) : raw;
        const method = entry.data ? 8 : 0;
        const crc = crc32(raw);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034B50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6); // UTF-8 names
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(dosTime, 10);
        local.writeUInt16LE(dosDate, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(name.length, 26);
        locals.push(local, name, packed);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014B50, 0);
        central.writeUInt16LE((3 << 8) | 20, 4); // made by: unix
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(dosTime, 12);
        central.writeUInt16LE(dosDate, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(packed.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(((entry.mode & 0xFFFF) << 16 | (entry.data ? 0 : 0x10)) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += local.length + name.length + packed.length;
    }
    const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054B50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    await writeFile(file, Buffer.concat([...locals, ...centrals, end]));
};

const tarGz = (cwd, name, file) =>
    execFileSync('tar', ['-czf', file, '--owner=0', '--group=0', name], {cwd, stdio: 'inherit'});

// Release bundle h6ai-<version>/: the built _h6ai folder, the installer (native or Docker) and
// the nginx/PHP configuration both share.
const RELEASE_FILES = ['install.sh', 'deploy', 'README.md', 'CHANGELOG.md', 'SECURITY.md', 'LICENSE',
    'docs/INSTALL.md', 'docs/DEPLOYMENT.md', 'docs/install',
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
    for (const suffix of ['.tar.gz', '.zip', '-dropin.tar.gz', '-dropin.zip']) {
        await rm(join(BUILD, base + suffix), {force: true});
    }
    tarGz(BUILD, base, `${base}.tar.gz`);
    await writeZip(stage, base, join(BUILD, `${base}.zip`));
    await rm(stage, {recursive: true, force: true});

    // drop-in: just _h6ai, extracted straight into a web root (like h5ai's zip)
    tarGz(BUILD, '_h6ai', `${base}-dropin.tar.gz`);
    await writeZip(DEST, '_h6ai', join(BUILD, `${base}-dropin.zip`));
    console.log(`release packages written to ${relative(ROOT, BUILD)}/${base}{,-dropin}.{tar.gz,zip}`);
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
