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
// One script for both apps, because the difference between them is entirely in
// what their `main.ts` does. `node tools/build-electron.ts set`.

import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2];

if (!name) {
  console.error('build-electron: name a module — set, or visuals');
  process.exit(1);
}

const here = path.join(root, name, 'electron');
if (!fs.existsSync(path.join(here, 'main.ts'))) {
  console.error(`build-electron: no ${name}/electron/main.ts`);
  process.exit(1);
}

await esbuild.build({
  entryPoints: [path.join(here, 'main.ts'), path.join(here, 'preload.ts')],
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

const size = (file: string) => fs.statSync(path.join(here, 'dist', file)).size;
console.log(
  `built ${name}/electron/dist — main ${(size('main.cjs') / 1024).toFixed(0)} kB, ` +
    `preload ${(size('preload.cjs') / 1024).toFixed(1)} kB`,
);
