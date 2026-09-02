// The mix main-process modules locate the app's bin/ and python/ from
// `__dirname`, which is `mix/electron/dist` when Electron runs the built
// main.cjs. A node tool importing them as ESM has no `__dirname`, so this
// defines it — imported first, before any of those modules evaluate.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
if (typeof globalThis.__dirname === 'undefined') {
  (globalThis as unknown as { __dirname: string }).__dirname = path.resolve(here, '..', 'mix', 'electron', 'dist');
}
