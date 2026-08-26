#!/usr/bin/env node
// Dev-mode watcher that writes bridge/bridge.js — the `npm run dev` replacement
// for plain `tsc --watch`.
//
// bridge.ts now imports core/src, which sits outside bridge/src. Plain tsc
// refuses to emit outside its rootDir, so this bundles instead — bundling
// doesn't care where an import lives.
//
// esbuild strips types without checking them, so this gives no type errors.
// npm run dev's `types` task (`tsc --noEmit --watch`) covers that.

import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ctx = await esbuild.context({
  entryPoints: [path.join(root, 'bridge', 'src', 'bridge.ts')],
  outfile: path.join(root, 'bridge', 'bridge.js'),
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['max-api', 'bufferutil', 'utf-8-validate'],
  legalComments: 'none',
  minify: false,
});

await ctx.watch();
console.log('dev-bridge — watching bridge/src + core/src -> bridge/bridge.js');
