#!/usr/bin/env node
// Bundles one module's Electron main and preload into CommonJS.
//
// It exists for the same reason `build-bridge.ts` does: a Node runtime that is
// not ours to pick. Electron ships its own Node, that Node does not strip types
// the way Node 24 on your PATH does, and `--experimental-strip-types` is not a
// flag to rely on inside somebody else's runtime. So the main process is built
// rather than run from source, and it is built to **CommonJS** because a
// `sandbox: true` preload must be — which is not a limitation to work around,
// since a sandboxed preload is the whole reason the renderer can be trusted with
// `contextIsolation`.
//
// One script for every app, because the difference between them is entirely in
// what their `main.ts` does — and most of what it does is now
// `@openflow/desktop`, bundled in from here. `node tools/build-electron.ts set`.

import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, NAMES } from '@openflow/desktop/apps.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const name = process.argv[2];
if (!name || !NAMES.includes(name)) {
  console.error(`build-electron: name an app — ${NAMES.join(', ')}`);
  process.exit(1);
}
const one = app(name);

const here = path.join(root, name, 'electron');
if (!fs.existsSync(path.join(here, 'main.ts'))) {
  console.error(`build-electron: no ${name}/electron/main.ts`);
  process.exit(1);
}

/**
 * The app's own server, bundled to run beside it rather than from source.
 *
 * visual[flow] spawns one. Unpackaged that could be `node server/index.ts` off
 * disk, but a packaged `.app` has no source tree — and, launched from Finder, no
 * `node` on its PATH either, because a GUI process inherits `/usr/bin:/bin` and
 * not whatever a shell profile added. So the server is bundled and run by
 * Electron's own Node (`ELECTRON_RUN_AS_NODE`), which is always there.
 *
 * That works because the one native dependency, the Ableton Link addon, is
 * **node-addon-api** — N-API, whose whole point is an ABI that holds across Node
 * *and* Electron versions. Verified by loading it: no rebuild, no per-upgrade
 * repair. It stays external and ships unpacked, because a `.node` binary cannot
 * be inlined into a bundle or read out of an asar.
 *
 * Which apps have one is `desktop/src/apps.ts`, so adding a third is an entry in
 * the registry rather than an edit here.
 */
const entries = [path.join(here, 'main.ts'), path.join(here, 'preload.ts')];
const server = one.server?.entry;

await esbuild.build({
  entryPoints: entries,
  outdir: path.join(here, 'dist'),
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // Electron's bundled Node, not the one on your PATH. Conservative for the
  // same reason bridge.ts targets node18: the runtime is not ours to assume.
  target: 'node20',
  // Provided by the runtime itself and unbundlable — resolving it would inline
  // a stub that silently does nothing.
  external: ['electron'],
  legalComments: 'none',
  minify: false, // this is what you read when a window does not open
});

if (server) {
  await esbuild.build({
    entryPoints: [path.join(root, name, server)],
    outfile: path.join(here, 'dist', 'server.mjs'),
    bundle: true,
    platform: 'node',
    // ESM, unlike the two above: the server reads `import.meta.url` to find its
    // own renderer, and `link.ts` builds a `createRequire` from it to reach the
    // Link addon. Both are empty in a CJS bundle.
    format: 'esm',
    target: 'node20',
    external: ['@ktamas77/abletonlink'],
    // `ws` and its friends are CommonJS, and esbuild's ESM output leaves their
    // `require` calls to a shim that looks for a global one — which ESM has no
    // such thing as. This is that global, built the only way ESM can build it.
    banner: {
      js: [
        "import { createRequire as __openflowRequire } from 'node:module';",
        'const require = __openflowRequire(import.meta.url);',
      ].join('\n'),
    },
    legalComments: 'none',
    minify: false,
  });
}

const size = (file: string) => fs.statSync(path.join(here, 'dist', file)).size;
const kB = (file: string) => `${(size(file) / 1024).toFixed(0)} kB`;
console.log(
  `built ${name}/electron/dist — main ${kB('main.cjs')}, preload ${kB('preload.cjs')}` +
    (server ? `, server ${kB('server.mjs')}` : ''),
);
