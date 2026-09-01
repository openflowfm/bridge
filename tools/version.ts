#!/usr/bin/env node
// Sets one version across every package.json in the repo. `npm run dev:version 0.2.0-dev`.
//
// This exists because the version is not one number. Four independent things
// read it, and only one of them is the root:
//
//   root package.json      the line on the device face (build-device.ts)
//   set/package.json       set-flow-<version>-arm64.dmg, and CFBundleShortVersionString
//   visuals/package.json   visual-flow-<version>-arm64.dmg, likewise
//   core/ protocol/ widgets/   the npm tarballs attached to a release
//
// Left to drift, a `v0.2.0` tag produces a release containing
// `set-flow-0.1.0-arm64.dmg`. The guard in `release.yml` refuses that tag; this
// is the thing that stops you hitting the guard in the first place.
//
// `npm version --workspaces --include-workspace-root` does most of it and
// silently misses the two that matter most: `visuals/` and `bridge/` are not
// workspaces — they carry their own package-lock.json and their own node_modules
// — and `visuals/` is the one that names a .dmg.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const version = process.argv[2];
if (!version) {
  console.error('usage: npm run dev:version <version>    e.g. 0.2.0-dev, 0.2.0-rc.1, 0.2.0');
  process.exit(1);
}

// Semver, and deliberately not a loose one. A version that npm accepts but
// electron-builder or Apple chokes on is a failure nine minutes into a
// notarised build rather than here.
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`not a version this repo can build: ${version}`);
  console.error('want MAJOR.MINOR.PATCH with an optional prerelease: 0.2.0-dev, 0.2.0-rc.1');
  process.exit(1);
}

/**
 * Every package.json that carries a version, found rather than listed.
 *
 * The workspaces come from the root manifest so that adding one is not also a
 * silent way to leave it behind here. `visuals` and `bridge` are appended by
 * name because nothing in the manifest mentions them — that separateness is
 * exactly the bug this file exists to prevent.
 */
function manifests(): string[] {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const dirs = ['.', ...(rootPkg.workspaces ?? []), 'visuals', 'bridge'];
  return dirs
    .map((dir) => path.join(root, dir, 'package.json'))
    .filter((file) => fs.existsSync(file));
}

/**
 * Rewrites the `version` field and touches nothing else.
 *
 * A parse/stringify round trip would reformat the whole file — key order
 * survives, but npm's two-space indent and the exact trailing newline are
 * conventions rather than guarantees, and a version bump that reflows nine
 * manifests is a diff nobody can read. So: the first `"version"` line, in
 * place.
 */
function setVersion(file: string): string | null {
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(/^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${version}$2`);
  if (after === before) return null;
  fs.writeFileSync(file, after);
  return JSON.parse(before).version;
}

const changed: string[] = [];
for (const file of manifests()) {
  const was = setVersion(file);
  const name = path.relative(root, file);
  if (was === null) {
    console.error(`no version field in ${name}`);
    process.exit(1);
  }
  changed.push(`  ${name.padEnd(24)} ${was} → ${version}`);
}

console.log(`version ${version}\n${changed.join('\n')}`);

// The locks carry the version too — the root one for the root package and for
// every workspace link inside it, and the other two for their own package. A
// bump that skips them leaves `npm ci` installing a tree that disagrees with the
// manifest, which is a failed release job rather than a warning.
//
// `--package-lock-only` writes the lock without touching node_modules, so this
// stays a text edit.
for (const dir of ['.', 'bridge', 'visuals']) {
  const cwd = path.join(root, dir);
  if (!fs.existsSync(path.join(cwd, 'package-lock.json'))) continue;
  const done = spawnSync(
    'npm',
    ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd, stdio: 'inherit' },
  );
  if (done.status !== 0) {
    console.error(`could not refresh ${path.join(dir, 'package-lock.json')}`);
    process.exit(1);
  }
}

console.log(
  '\nlocks refreshed. Commit all of it together — a manifest and a lock that\n' +
    'disagree fail `npm ci` on the next release, not here.',
);
