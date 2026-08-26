#!/usr/bin/env node
// Bundles bridge/src/bridge.ts into a single self-contained bridge/bridge.js.
//
// The point is what the user ends up holding. Unbundled, a shipped device is a
// folder — bridge.js, lom.js, node_modules/ws — and the user has to keep all of
// it together, which is not a thing you can ask of someone downloading a Live
// device. Bundled, the runtime is two files, and two files are something Live's
// freeze can plausibly swallow into the .amxd itself.
//
// So `ws` is inlined. The built session manager used to ride along too, as base64
// in a `define` — 595 kB of it, three quarters of the file — and it does not any
// more: set[flow] is a desktop app and the device serves nothing.
//
// `npm run dev` does NOT use this — it keeps plain `tsc --watch`, which is faster.

import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'bridge', 'bridge.js');

await esbuild.build({
  entryPoints: [path.join(root, 'bridge', 'src', 'bridge.ts')],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // Node for Max, not the Node on your PATH. Conservative rather than current:
  // the runtime inside Max is not ours to pick and not ours to assume.
  target: 'node18',
  // max-api is provided by Max itself and cannot be bundled — resolving it would
  // either fail the build or, worse, inline a stub that silently does nothing.
  // ws's two optional native speedups are require'd inside a try/catch; left
  // external they simply stay unavailable, which is how they already are.
  external: ['max-api', 'bufferutil', 'utf-8-validate'],
  legalComments: 'none',
  minify: false, // this is what you read in the Max window when it goes wrong
});

const size = fs.statSync(OUT).size;
console.log(`bundled bridge.js — ${(size / 1024).toFixed(0)} kB`);
