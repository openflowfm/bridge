#!/usr/bin/env node
// Copies the built probe into Ableton's User Library. `npm run install:probe`.
// The same shape as install-device.ts, for the same reasons.
//
// **Into a folder of its own.** The device runs `[v8 probe.js]`, which Max
// resolves by name from the patcher's own folder, so the script travels with it
// and must not land beside SessionBridge's scripts or another probe build's.
// The `-qa` suffix is the name Live shows you; the folder is what keeps them
// apart.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** See install-device.ts: the default User Library, or `OPENFLOW_USER_LIBRARY`. */
const LIB =
  process.env.OPENFLOW_USER_LIBRARY ||
  path.join(os.homedir(), 'Music', 'Ableton', 'User Library', 'Max for Live');

const SUFFIX = '-qa';
const DEVICE = 'OpenFlowProbe';
/** The one file Max loads by name, which is why it travels with the device. */
const SCRIPTS = ['probe.js'];

if (process.platform !== 'darwin') {
  console.log('install-probe: not macOS — nothing to install');
  process.exit(0);
}

const from = path.join(root, 'probe');
const missing = [`${DEVICE}.amxd`, ...SCRIPTS].filter(
  (file) => !fs.existsSync(path.join(from, file)),
);
if (missing.length) {
  console.error(
    `install-probe: probe/${missing.join(', probe/')} not built — run: npm run build:probe`,
  );
  process.exit(1);
}

if (!fs.existsSync(LIB)) {
  console.error(
    `install-probe: no Max for Live folder at\n` +
      `        ${LIB}\n` +
      `      If the User Library lives elsewhere, say so:\n` +
      `        OPENFLOW_USER_LIBRARY="/path/to/User Library/Max for Live" npm run install:probe`,
  );
  process.exit(1);
}

const into = path.join(LIB, `${DEVICE}${SUFFIX}`);
fs.mkdirSync(into, { recursive: true });

// The device is renamed; the script is not, because the patcher asks for it by
// the name it was built with.
const device = `${DEVICE}${SUFFIX}.amxd`;
fs.copyFileSync(path.join(from, `${DEVICE}.amxd`), path.join(into, device));
for (const script of SCRIPTS) {
  fs.copyFileSync(path.join(from, script), path.join(into, script));
}

const kB = (file: string) => `${(fs.statSync(path.join(into, file)).size / 1024).toFixed(0)} kB`;
console.log(
  `installed ${device} → ${into.replace(os.homedir(), '~')}\n  with probe.js ${kB('probe.js')}`,
);
console.log('Live caches a loaded device: reload it to pick this up.');
