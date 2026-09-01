#!/usr/bin/env node
// Copies the packed apps into /Applications/open[flow]. `npm run install:apps`.
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
import { NAMES } from '@openflow/desktop/apps.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where they land. Overridable because `/Applications` needs admin rights on a
 * managed machine, and `~/Applications` is the per-user directory macOS reads
 * the same way — it just has to exist first.
 */
const DEST = process.env.OPENFLOW_APPS || '/Applications';

/**
 * The folder inside it that they land in.
 *
 * Three bundles loose in /Applications are three unrelated icons that someone
 * has to already know are related. In a folder of their own they sort together,
 * read as one suite, and the Dock can hold the whole thing as a single stack.
 *
 * Brackets, like the apps themselves. Nothing here shells out — `ditto`, `xattr`
 * and `pgrep` are each spawned with an argument array, and `running()` escapes
 * the path before it becomes a pattern — so the only place they bite is a human
 * typing the path into zsh unquoted, which `set[flow].app` has always done too.
 */
const FOLDER = 'open[flow]';

/** Where a bundle actually ends up. */
const HOME = path.join(DEST, FOLDER);

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
 * Whether the quarantine flag is on a bundle. Checked after stripping rather
 * than assumed, because it is the whole difference between a double-click and a
 * dialog, and `xattr -d` succeeds cheerfully when it removed nothing.
 *
 * The bundle root is the one that counts — that is where Gatekeeper reads it.
 */
function quarantined(app: string): boolean {
  return spawnSync('xattr', ['-p', 'com.apple.quarantine', app], { stdio: 'ignore' }).status === 0;
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
const names = wanted.length ? wanted : NAMES;

const unknown = names.filter((name) => !NAMES.includes(name));
if (unknown.length) {
  console.error(`install-apps: no such app — ${unknown.join(', ')}. Try: ${NAMES.join(', ')}`);
  process.exit(1);
}

if (!fs.existsSync(DEST)) {
  console.error(`install-apps: ${DEST} does not exist`);
  process.exit(1);
}

// Made rather than assumed — and this is the first thing here that writes to
// DEST, so a machine where /Applications is not yours says so now, before
// anything has been copied or deleted.
try {
  fs.mkdirSync(HOME, { recursive: true });
} catch {
  console.error(
    `install-apps: could not create ${HOME}.\n` +
      `      If ${DEST} is not yours to write, install for yourself instead:\n` +
      `        mkdir -p ~/Applications && OPENFLOW_APPS=~/Applications npm run install:apps`,
  );
  process.exit(1);
}

let installed = 0;
for (const name of names) {
  const src = bundle(name);
  if (!src) {
    console.error(`install-apps: ${name} is not packed — run: npm run pack:${name}`);
    process.exit(1);
  }

  const dst = path.join(HOME, path.basename(src));
  if (running(dst)) {
    console.error(`install-apps: ${path.basename(dst)} is open — quit it first`);
    process.exit(1);
  }

  // Where every install before this one put it. Left alone it is a second bundle
  // by the same name one directory up: Spotlight offers both, the Dock may still
  // hold the stale one, and a QA pass can end up driving the build it meant to
  // replace. It is our own copy of a build artifact, so it goes.
  const loose = path.join(DEST, path.basename(src));
  if (loose !== dst && fs.existsSync(loose)) {
    if (running(loose)) {
      console.error(
        `install-apps: the older ${path.basename(loose)} in ${DEST} is open — quit it first`,
      );
      process.exit(1);
    }
    fs.rmSync(loose, { recursive: true, force: true });
    console.log(`cleared the older ${path.basename(loose)} out of ${DEST}`);
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
      `install-apps: could not write to ${HOME}.\n` +
        `      If it is not yours to write, install for yourself instead:\n` +
        `        mkdir -p ~/Applications && OPENFLOW_APPS=~/Applications npm run install:apps`,
    );
    process.exit(1);
  }

  // Quarantine is the flag that makes macOS ask before a first launch, and for
  // these it is worse than an ask: electron-builder rewrote the bundle without
  // re-sealing its resources, so a quarantined copy is one Gatekeeper *rejects*
  // on the signature rather than one it merely distrusts — `spctl` says "code
  // has no resources but signature indicates they must be present". Right-click
  // → Open does not reliably get past that.
  //
  // A locally built bundle carries no flag to begin with, so this is belt and
  // braces for a copy that arrived some other way. Either way it is gone before
  // the app is yours to open.
  spawnSync('xattr', ['-dr', 'com.apple.quarantine', dst], { stdio: 'ignore' });
  if (quarantined(dst)) {
    console.error(
      `install-apps: ${path.basename(dst)} is still quarantined — it will not open cleanly.\n` +
        `      Try by hand: xattr -dr com.apple.quarantine "${dst}"`,
    );
    process.exit(1);
  }

  console.log(`installed ${path.basename(dst)} → ${HOME}`);
  installed += 1;
}

console.log(
  `${installed} app${installed === 1 ? '' : 's'} in ${HOME}, unquarantined — double-click and go.`,
);
