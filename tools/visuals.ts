#!/usr/bin/env node
// The way to run the rig on a show night: the renderer built, the visuals
// server on its own and kept up, and a browser that belongs to the show.
//
// `npm run dev` is the wrong thing to have documented for this. It is
// `concurrently -k` over ten dev processes, and `-k` means *any one* of them
// exiting kills all of the others — so a chart server, a vite watcher or a tsc
// task falling over takes the visuals server down with it, mid-set, for a
// reason that has nothing to do with the wall.
//
// This runs the one process that matters and nothing else. If it exits anyway,
// it comes back: with the backstops in `visuals/server`, that should be rare,
// and a rig that restarts in a second is a rig that loses a bar rather than an
// evening.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(root, 'visuals', 'server', 'index.ts');
const PORT = Number(process.env.OPENFLOW_VISUALS_PORT) || 17900;
const RIG = `http://localhost:${PORT}`;
const BROWSE = !process.argv.includes('--no-browse');

/** How long to wait before bringing it back, so a hard failure cannot spin. */
const RESTART_MS = 1000;
/** How long to wait for the port to answer before giving up on the window. */
const READY_MS = 20_000;

/**
 * A Chrome that belongs to the show and to nothing else.
 *
 * Not a flag on the browser you read your mail in. A separate `--user-data-dir`
 * is a separate *instance*: no extensions, no forty other tabs on the same GPU,
 * its own budget of the ~16 WebGL contexts a browser keeps per origin, and its
 * own permissions — so the window-management grant the wall needs is given once
 * and stays given, rather than being asked for again on a stage.
 *
 * It is also the lightest Chromium available here, because it is the Chromium
 * already installed. There is no bundle to sign and no updater to own.
 *
 * The same `~/.openflow` root the schemes use — see `visuals/server/home.ts`,
 * which is where that rule is written down.
 */
const home = process.env.OPENFLOW_HOME ?? path.join(os.homedir(), '.openflow');
const profile = path.join(home, 'visuals', 'chrome');

const CHROME = [
  '/Applications/Google Chrome.app',
  path.join(os.homedir(), 'Applications', 'Google Chrome.app'),
];

const FLAGS = [
  `--user-data-dir=${profile}`,
  // A window with no tabs, no address bar and no bookmark strip.
  `--app=${RIG}`,
  // Chrome slows and eventually freezes a renderer it decides nobody is looking
  // at, and a wall window sitting behind the console is exactly that. The three
  // together are what stop the projector dropping to a stutter because somebody
  // brought another window to the front.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  // A fresh profile otherwise opens on the welcome tour.
  '--no-first-run',
  '--no-default-browser-check',
];

/** Whether anything is listening yet. The window must not open on a refusal. */
const answering = () =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect({ port: PORT, host: '127.0.0.1' });
    const done = (yes: boolean) => {
      socket.destroy();
      resolve(yes);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });

/** Long enough for a port already in use to have failed. See `openWindow`. */
const SETTLE_MS = 400;

const openWindow = async () => {
  // A beat before the first look, and it is not politeness. If something else
  // is already on the port, the very first poll succeeds — against *that* — and
  // a window opens onto somebody else's server a moment before ours dies of
  // EADDRINUSE. Waiting gives that failure time to land, and `child` going null
  // is what says it did.
  await new Promise((wake) => setTimeout(wake, SETTLE_MS));
  const waited = Date.now() + READY_MS;
  while (child && Date.now() < waited) {
    if (await answering()) break;
    await new Promise((wake) => setTimeout(wake, 150));
  }
  if (!child) return; // Gone before it ever listened. Not ours to open onto.
  if (!(await answering())) {
    console.error(`visuals: the server never answered on ${PORT} — open ${RIG} yourself`);
    return;
  }
  if (process.platform !== 'darwin') {
    console.log(`visuals: open ${RIG} — and see tools/README.md for the flags worth using`);
    return;
  }
  const app = CHROME.find((at) => fs.existsSync(at));
  if (!app) {
    console.log(`visuals: Google Chrome is not installed — open ${RIG} yourself`);
    return;
  }
  // Already up, from an earlier run tonight. Launching again would stack a
  // second window on the same profile rather than doing anything useful.
  if (spawnSync('pgrep', ['-f', profile]).status === 0) {
    console.log(`visuals: a show browser is already open on ${RIG}`);
    return;
  }
  fs.mkdirSync(profile, { recursive: true });
  spawn('open', ['-na', app, '--args', ...FLAGS], { detached: true, stdio: 'ignore' }).unref();
  console.log(`visuals: ${RIG} in its own Chrome — profile ${profile}`);
};

const build = spawnSync('npm', ['run', 'build:visuals'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) {
  console.error('visuals: the renderer did not build — not starting the server');
  process.exit(build.status ?? 1);
}

let stopping = false;
let opened = false;
let child: ReturnType<typeof spawn> | null = null;

const start = () => {
  child = spawn('node', ['--disable-warning=ExperimentalWarning', server], {
    cwd: root,
    stdio: 'inherit',
  });
  // Once, on the first start and never on a restart: the page reconnects by
  // itself, so a server that came back does not need a second window.
  if (BROWSE && !opened) {
    opened = true;
    void openWindow();
  }
  child.on('exit', (code, signal) => {
    child = null;
    // A clean exit is the server's own shutdown path — Ctrl-C, a SIGTERM — and
    // bringing it back from that would make it impossible to stop. A port
    // already taken (2) never resolves by waiting either: something else is on
    // it, and the server has already said which and how to find it.
    const done =
      stopping || signal === 'SIGINT' || signal === 'SIGTERM' || code === 0 || code === 2;
    if (done) {
      process.exit(code ?? 0);
    }
    console.error(
      `visuals: the server exited (${signal ?? code}) — restarting in ${RESTART_MS}ms`,
    );
    setTimeout(start, RESTART_MS);
  });
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
  });
}

start();
