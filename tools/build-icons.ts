#!/usr/bin/env node
// Makes an app's `.icns` from the open[flow] mark and one background colour.
//
// The mark is the suite's and is shared on purpose — these are two halves of one
// thing. What separates them is the colour behind it, and that is the whole
// design brief: at Dock size, and in a ⌘-Tab strip, hue is the only thing anyone
// actually reads. A shape difference at 32 pixels is not a difference.
//
// `sips` and `iconutil` ship with macOS, which is the only platform that wants
// an `.icns` at all. Generated at pack time rather than committed: an icon
// derived from a file already in the repo is an artifact, not a source.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The mark, and what each app puts behind it. */
const APPS: Record<string, string> = {
  // Near-black, the surface the session manager already draws on.
  set: '1A1A1E',
  // Amber, because a projector rig should be the one you can pick out at a
  // glance in the dark.
  visuals: 'F0B23C',
};

const SOURCE = path.join(root, 'set', 'public', 'logo-white.png');
/** Every size macOS asks an iconset for. */
const SIZES = [16, 32, 128, 256, 512];

const run = (cmd: string, args: string[]): void => {
  const done = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });
  if (done.status !== 0) throw new Error(`${cmd} failed`);
};

const name = process.argv[2];
const background = name ? APPS[name] : undefined;
if (!background) {
  console.error(`build-icons: name a module — ${Object.keys(APPS).join(', ')}`);
  process.exit(1);
}

if (process.platform !== 'darwin') {
  console.log('build-icons: not macOS — nothing to make');
  process.exit(0);
}

const out = path.join(root, name, 'electron', 'dist');
fs.mkdirSync(out, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'openflow-icon-'));
const iconset = path.join(scratch, 'icon.iconset');
fs.mkdirSync(iconset);

try {
  // Square first. The mark is 593×530, and an icon that is not square is an
  // icon macOS squashes.
  const square = path.join(scratch, 'square.png');
  run('sips', [
    '-s', 'format', 'png',
    '--padToHeightWidth', '1024', '1024',
    '--padColor', background,
    SOURCE,
    '--out', square,
  ]);

  for (const size of SIZES) {
    for (const [scale, suffix] of [[1, ''], [2, '@2x']] as const) {
      run('sips', [
        '-z', String(size * scale), String(size * scale),
        square,
        '--out', path.join(iconset, `icon_${size}x${size}${suffix}.png`),
      ]);
    }
  }

  run('iconutil', ['-c', 'icns', iconset, '-o', path.join(out, 'icon.icns')]);
  console.log(`built ${name}/electron/dist/icon.icns — the mark on #${background}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
