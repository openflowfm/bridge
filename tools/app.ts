#!/usr/bin/env node
// Every app, driven from one place. `node tools/app.ts <command> [app…]`.
//
// It exists because the per-app npm scripts were the other half of the cost of
// adding an app. There were five of them each — `build:set`, `set`,
// `dev:set-app`, `pack:set` and a lane in `dev` — and `pack:set` was a
// two-hundred-character line that differed from `pack:visuals` in one word. A
// third app meant five more, written by copying, which is how the QA overrides
// in one of them stop matching the other.
//
// Now the named scripts are one-line aliases onto this, and an app that has
// nothing special about it needs none of them at all: `npm run app -- run mix`
// works the day the registry names it.
//
//   build     the renderer, with vite
//   electron  main, preload and — if it has one — the server, with esbuild.
//             Runs `<app>/tools/prepare.ts` first, for an app that has one
//   icons     the .icns, from that app's own mark
//   run       build, electron, and open it
//   watch     its dev server and its window, together — the one to type
//   dev       electron, and open it against a dev server that is already up
//   pack      build, electron, icons, and electron-builder
//
// With no app named, every command but `run` and `dev` does all of them. Anything
// that looks like a flag is handed to electron-builder, which is what keeps
// `npm run pack:set -- -c.mac.identity="Developer ID Application: …"` working.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAMES } from '@openflow/desktop/apps.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = (name: string) => path.join(root, 'node_modules', '.bin', name);
const node = (script: string, args: string[]) =>
  run(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    path.join(root, script),
    ...args,
  ]);

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): void {
  const done = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (done.status !== 0) process.exit(done.status ?? 1);
}

const build = (name: string) => run(bin('vite'), ['build', '--config', `${name}/vite.config.ts`]);

/**
 * An app's own build step, if it has one: `<app>/tools/prepare.ts`.
 *
 * The seam exists for the thing neither vite nor esbuild makes. mix[flow] is
 * the one app with such a thing — it carries a pinned `uv` so a packaged build
 * can install its own Python engine — and the alternative was a mix-shaped
 * branch in here or a mix-shaped field in the registry, neither of which is
 * about apps in general.
 *
 * Run from `electron`, which is the step every path that produces a runnable
 * app goes through: `run`, `dev`, `watch` and `pack` alike.
 */
const prepare = (name: string) => {
  if (fs.existsSync(path.join(root, name, 'tools', 'prepare.ts'))) {
    node(`${name}/tools/prepare.ts`, []);
  }
};

const electron = (name: string) => {
  prepare(name);
  node('tools/build-electron.ts', [name]);
};
const icons = (name: string) => node('tools/build-icons.ts', [name]);

/**
 * The signed pair, or the ad-hoc bundle QA wants.
 *
 * `OPENFLOW_QA` overrides the disk image and the identity, because
 * `install:apps` copies the `.app` locally and never opens an image — measured
 * at 4.7s against about three minutes for the signed, notarised pair. The
 * electron version is read off the installed package rather than pinned here,
 * so an upgrade is one `npm install`.
 */
function pack(name: string): void {
  build(name);
  electron(name);
  icons(name);
  const read = "JSON.stringify(require('electron/package.json').version)";
  const version = JSON.parse(
    spawnSync(process.execPath, ['-p', read], { cwd: root, encoding: 'utf8' }).stdout,
  ) as string;
  run(bin('electron-builder'), [
    '--config',
    'electron-builder.yml',
    '--project',
    name,
    `-c.electronVersion=${version}`,
    ...(process.env.OPENFLOW_QA ? ['-c.mac.target=dir', '-c.mac.identity=null'] : []),
    // Last, so anything said on the command line wins over what is said here —
    // signing with a named identity on a machine that has one, most of all.
    ...flags,
  ]);
}

/** The window, on what is built. The show-night command, and the slow one. */
function open(name: string): void {
  build(name);
  electron(name);
  run(bin('electron'), [name]);
}

/**
 * Working on one app: its dev server and its window, in one command.
 *
 * `watch` is `dev` plus the vite server `dev` refuses to start, and it is the
 * thing to type. Two terminals is the honest arrangement when `npm run dev` is
 * already running every server in the repo, and a nuisance when it is not —
 * which is most of the time, because most work is on one app.
 *
 * `-k` is what makes it one command rather than two in a trench coat: closing
 * the window takes vite with it, and a vite that cannot bind takes the window's
 * retry loop with it rather than leaving it asking forever.
 *
 * Both halves are named by absolute path. This may be run from an npm script,
 * which puts `node_modules/.bin` on the PATH, or straight from a shell, which
 * does not — and the path to this repo has a space in it.
 */
function watch(name: string): void {
  const quoted = (what: string) => `"${what}"`;
  run(bin('concurrently'), [
    '-k',
    '-n',
    `${name}-ui,${name}-app`,
    '-c',
    'gray,green',
    `${quoted(bin('vite'))} --config ${name}/vite.config.ts`,
    [
      quoted(process.execPath),
      '--disable-warning=ExperimentalWarning',
      quoted(path.join(root, 'tools', 'app.ts')),
      'dev',
      name,
    ].join(' '),
  ]);
}

/**
 * The window, on a dev server somebody else is running.
 *
 * It does not start one: the dev servers are `npm run dev`'s to own, and an app
 * that started its own would race it for the port. What this does is rebuild the
 * main process — which vite knows nothing about — and open onto whatever is
 * there, retrying until it answers.
 */
function dev(name: string): void {
  electron(name);
  run(bin('electron'), [name], { OPENFLOW_DEV: '1' });
}

const [command, ...rest] = process.argv.slice(2);
const flags = rest.filter((arg) => arg.startsWith('-'));
const wanted = rest.filter((arg) => !arg.startsWith('-'));

if (flags.length && command !== 'pack') {
  console.error(`app: ${command} takes no options — ${flags.join(' ')} is electron-builder's`);
  process.exit(1);
}

const unknown = wanted.filter((name) => !NAMES.includes(name));
if (unknown.length) {
  console.error(`app: no such app — ${unknown.join(', ')}. Try: ${NAMES.join(', ')}`);
  process.exit(1);
}

const one = (what: (name: string) => void): void => {
  const [name] = wanted;
  if (!name) {
    console.error(`app: ${command} takes one app — ${NAMES.join(', ')}`);
    process.exit(1);
  }
  what(name);
};
const every = (what: (name: string) => void): void => {
  for (const name of wanted.length ? wanted : NAMES) what(name);
};

switch (command) {
  case 'build':
    every(build);
    break;
  case 'electron':
    every(electron);
    break;
  case 'icons':
    every(icons);
    break;
  case 'pack':
    every(pack);
    break;
  case 'run':
    one(open);
    break;
  case 'watch':
    one(watch);
    break;
  case 'dev':
    one(dev);
    break;
  default:
    console.error(
      `app: no such command — ${command ?? '(none named)'}.\n` +
        '     Try: build, electron, icons, pack, run, watch, dev',
    );
    process.exit(1);
}
