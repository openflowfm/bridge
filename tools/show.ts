#!/usr/bin/env node
// The way to run the rig on a show night: the renderer built, then the visuals
// server on its own, kept up.
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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(root, 'visuals', 'server', 'index.ts');

/** How long to wait before bringing it back, so a hard failure cannot spin. */
const RESTART_MS = 1000;

const build = spawnSync('npm', ['run', 'build:visuals'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) {
  console.error('show: the renderer did not build — not starting the server');
  process.exit(build.status ?? 1);
}

let stopping = false;
let child: ReturnType<typeof spawn> | null = null;

const start = () => {
  child = spawn('node', ['--disable-warning=ExperimentalWarning', server], {
    cwd: root,
    stdio: 'inherit',
  });
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
      `show: the visuals server exited (${signal ?? code}) — restarting in ${RESTART_MS}ms`,
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
