#!/usr/bin/env node
// Copies the packed apps into /Applications. `npm run install:apps`.
//
// The last step `npm run pack` deliberately does not take. Packing writes a
// bundle under `release/`, which is a build artifact; putting it where the Dock
// and Spotlight will find it is a separate decision, and one you want to make
// after a set rather than in the middle of one.
//
// **Not called `install`.** `install` is an npm lifecycle hook, so a script by
// that name would run on every `npm install` — copying half-built apps into
// /Applications as a side effect of adding a dependency. `install:apps` is not a
// lifecycle name and is safe.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The modules that produce an app, and the script that packs each one. */
const APPS = ['set', 'visuals'];

/**
 * Where they land. Overridable because `/Applications` needs admin rights on a
 * managed machine, and `~/Applications` is the per-user directory macOS reads
 * the same way — it just has to exist first.
 */
const DEST = process.env.OPENFLOW_APPS || '/Applications';

if (process.platform !== 'darwin') {
  console.log('install-apps: not macOS — nothing to install');
  process.exit(0);
}

/**
 * The `.app` electron-builder's `dir` target left behind, whatever it named the
 * architecture — `mac-arm64` here, `mac` on Intel, and something else again the
 * day this cross-builds.
 */
function bundle(name: string): string | null {
  const out = path.join(root, 'release', name);
  if (!fs.existsSync(out)) return null;
  for (const dir of fs.readdirSync(out)) {
    if (!dir.startsWith('mac')) continue;
    const here = path.join(out, dir);
    const app = fs.readdirSync(here).find((file) => file.endsWith('.app'));
    if (app) return path.join(here, app);
  }
  return null;
}

/**
 * Whether the thing we are about to replace is open.
 *
 * Deleting a running bundle out from under macOS is allowed and behaves exactly
 * as badly as it sounds — the app keeps running against files that no longer
 * exist and dies at the next thing it tries to load. Worth one check.
 *
 * The names contain brackets, which `pgrep -f` reads as a character class, so
 * the path is escaped before it becomes a pattern.
 */
function running(app: string): boolean {
  const pattern = app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return spawnSync('pgrep', ['-f', pattern], { stdio: 'ignore' }).status === 0;
}

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : APPS;

const unknown = names.filter((name) => !APPS.includes(name));
if (unknown.length) {
  console.error(`install-apps: no such app — ${unknown.join(', ')}. Try: ${APPS.join(', ')}`);
  process.exit(1);
}

if (!fs.existsSync(DEST)) {
  console.error(`install-apps: ${DEST} does not exist`);
  process.exit(1);
}

let installed = 0;
for (const name of names) {
  const src = bundle(name);
  if (!src) {
    console.error(`install-apps: ${name} is not packed — run: npm run pack:${name}`);
    process.exit(1);
  }

  const dst = path.join(DEST, path.basename(src));
  if (running(dst)) {
    console.error(`install-apps: ${path.basename(dst)} is open — quit it first`);
    process.exit(1);
  }

  // Removed rather than copied over. `ditto` merges into an existing directory,
  // so without this an old build's files survive inside the new bundle and the
  // app that launches is neither version.
  fs.rmSync(dst, { recursive: true, force: true });

  // `ditto` rather than `cp -R`: an Electron bundle is full of symlinked
  // framework versions (`Versions/Current`), and this is the copy that keeps
  // them, along with the extended attributes and permissions.
  const done = spawnSync('ditto', [src, dst], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (done.status !== 0) {
    console.error(
      `install-apps: could not write to ${DEST}.\n` +
        `      If it is not yours to write, install for yourself instead:\n` +
        `        mkdir -p ~/Applications && OPENFLOW_APPS=~/Applications npm run install:apps`,
    );
    process.exit(1);
  }

  // These are unsigned, so a quarantine flag is the difference between opening
  // and a Gatekeeper refusal. A locally built bundle should not carry one — but
  // one that came off the `.dmg` does, and this is where that stops mattering.
  spawnSync('xattr', ['-dr', 'com.apple.quarantine', dst], { stdio: 'ignore' });

  console.log(`installed ${path.basename(dst)} → ${DEST}`);
  installed += 1;
}

console.log(`${installed} app${installed === 1 ? '' : 's'} in ${DEST}. They are unsigned: if one`);
console.log('refuses to open, right-click it and choose Open the first time.');
