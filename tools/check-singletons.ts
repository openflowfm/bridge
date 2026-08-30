#!/usr/bin/env node
// Refuses a second copy of a package that only works as one.
//
// `bridge/` and `visuals/` keep their own `node_modules` — the first because
// `bridge.js` ships beside Live with no dependency tree, the second because of
// the native Ableton Link addon and electron-builder's `!node_modules/**`. Both
// are right, and both are a place npm will happily install a *second* React
// while satisfying a peer dependency.
//
// That failure is bad out of proportion to its cause. Two Reacts means two
// module registries, so every `useContext` in a component rendered by the other
// copy reads a null dispatcher: `Cannot read properties of null (reading
// 'useContext')`, thrown from library code, nowhere near the install that did
// it. It took a full test suite to notice and a `find` to explain.
//
// The rule is one line long: the UI is bundled by the root toolchain, so
// anything React-peered belongs in the root `package.json`. `visuals/` and
// `bridge/` are the server and device sides — Link, `ws`, `zod`, the MCP SDK.
// This says so at the moment somebody gets it wrong, which is `postinstall`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Packages that break silently and confusingly when duplicated. */
const SINGLETONS = ['react', 'react-dom'];

/** Sub-packages with a dependency tree of their own. */
const NESTED = ['bridge', 'visuals'];

const versionAt = (dir: string, name: string): string | null => {
  const manifest = path.join(dir, 'node_modules', name, 'package.json');
  if (!fs.existsSync(manifest)) return null;
  return (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version: string }).version;
};

const problems: string[] = [];
for (const name of SINGLETONS) {
  const mine = versionAt(root, name);
  for (const nested of NESTED) {
    const theirs = versionAt(path.join(root, nested), name);
    if (!theirs) continue;
    problems.push(
      `${nested}/node_modules/${name}@${theirs} duplicates ${name}@${mine ?? 'none'} at the root`,
    );
  }
}

if (problems.length > 0) {
  console.error('check-singletons: a package that must be one copy is two.\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    [
      '',
      'Almost always: a React-peered package was installed into a sub-package,',
      'and npm satisfied the peer there. The UI is bundled by the root',
      'toolchain, so it belongs at the root instead:',
      '',
      `  cd ${NESTED.join(' or ')} && npm uninstall <package>`,
      '  npm install --save <package>          # from the repo root',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

console.log(`check-singletons: ${SINGLETONS.join(', ')} are one copy each`);
