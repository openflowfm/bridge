#!/usr/bin/env node
// Copies the built device into Ableton's User Library. `npm run install:device`.
//
// **Into a folder of its own, and that is not tidiness.** The device is
// `[node.script bridge.js]` and `[v8 lom.js]`, which Max resolves by name from
// the patcher's own folder — so two devices sharing one folder share one pair of
// scripts. A `-qa` suffix on the `.amxd` alone would isolate nothing: installing
// would overwrite the scripts the installed device runs, and break it. The
// suffix is for the name Live shows you; the folder is what keeps the two apart.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The default User Library location. Ableton lets you move it, and this makes no
 * attempt to find out where to — `OPENFLOW_USER_LIBRARY` points at the
 * `Max for Live` folder when it is not here.
 */
const LIB =
  process.env.OPENFLOW_USER_LIBRARY ||
  path.join(os.homedir(), 'Music', 'Ableton', 'User Library', 'Max for Live');

/**
 * So Live's browser and the device chain both say which one you loaded. The
 * whole point of installing this alongside a real one is being able to tell.
 */
const SUFFIX = '-qa';

const DEVICE = 'SessionBridge';
/** The two Max loads by name, which is why they travel with it. */
const SCRIPTS = ['bridge.js', 'lom.js'];

if (process.platform !== 'darwin') {
  console.log('install-device: not macOS — nothing to install');
  process.exit(0);
}

const from = path.join(root, 'bridge');
const missing = [`${DEVICE}.amxd`, ...SCRIPTS].filter(
  (file) => !fs.existsSync(path.join(from, file)),
);
if (missing.length) {
  console.error(
    `install-device: ${missing.join(', ')} not built — run: npm run build`,
  );
  process.exit(1);
}

if (!fs.existsSync(LIB)) {
  console.error(
    `install-device: no Max for Live folder at\n` +
      `        ${LIB}\n` +
      `      If the User Library lives elsewhere, say so:\n` +
      `        OPENFLOW_USER_LIBRARY="/path/to/User Library/Max for Live" npm run install:device`,
  );
  process.exit(1);
}

const into = path.join(LIB, `${DEVICE}${SUFFIX}`);
fs.mkdirSync(into, { recursive: true });

// The device is renamed; the scripts are not, because the patcher asks for them
// by the names it was built with.
const device = `${DEVICE}${SUFFIX}.amxd`;
fs.copyFileSync(path.join(from, `${DEVICE}.amxd`), path.join(into, device));
for (const script of SCRIPTS) {
  fs.copyFileSync(path.join(from, script), path.join(into, script));
}

const kB = (file: string) => `${(fs.statSync(path.join(into, file)).size / 1024).toFixed(0)} kB`;
console.log(
  `installed ${device} → ${into.replace(os.homedir(), '~')}\n` +
    `  with bridge.js ${kB('bridge.js')} and lom.js ${kB('lom.js')}`,
);
console.log('Live caches a loaded device: reload it to pick this up.');
