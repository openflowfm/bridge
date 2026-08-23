#!/usr/bin/env node
// Bundles bridge/src/bridge.ts into a single self-contained bridge/bridge.js.
//
// The point is what the user ends up holding. Unbundled, a shipped device is a
// folder — bridge.js, lom.js, node_modules/ws, public/ — and the user has to keep
// all of it together, which is not a thing you can ask of someone downloading a
// Live device. Bundled, the runtime is two files, and two files are something
// Live's freeze can plausibly swallow into the .amxd itself.
//
// So: `ws` is inlined, and the built UI rides along as base64 in a `define`.
//
// `npm run dev` does NOT use this — it keeps plain `tsc --watch`, which is faster
// and leaves OPENFLOW_ASSETS undefined so the bridge serves public/ off disk while
// vite owns the UI. See the OPENFLOW_ASSETS comment in bridge.ts.

import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(root, 'bridge', 'public');
const OUT = path.join(root, 'bridge', 'bridge.js');

/** Every file under public/, keyed by the URL path the bridge serves it at. */
function collect(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, collect(path.join(dir, entry.name), rel));
    // Source maps are a third of a megabyte each and only ever read by a
    // devtools window nobody has open on stage. The browser asking for one and
    // getting a 404 costs nothing.
    else if (!entry.name.endsWith('.map')) {
      out[rel] = fs.readFileSync(path.join(dir, entry.name)).toString('base64');
    }
  }
  return out;
}

const assets = collect(PUBLIC);
const assetBytes = Object.values(assets).reduce((n, b64) => n + b64.length, 0);

if (!Object.keys(assets).length) {
  console.warn(
    'build:bridge — public/ is empty, so the UI is NOT inlined. Run build:ui first ' +
      '(npm run build does). The device will serve nothing but the API.',
  );
}

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
  define: { OPENFLOW_ASSETS: JSON.stringify(assets) },
  legalComments: 'none',
  minify: false, // this is what you read in the Max window when it goes wrong
});

const size = fs.statSync(OUT).size;
console.log(
  `bundled bridge.js — ${(size / 1024).toFixed(0)} kB ` +
    `(${Object.keys(assets).length} inlined assets, ${(assetBytes / 1024).toFixed(0)} kB base64)`,
);
