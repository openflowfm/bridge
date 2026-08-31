#!/usr/bin/env node
// `npm run benchmark` — how fast this machine can draw every flow in the scheme.
//
// The question `visuals/docs/engine.md` leaves open is whether this rig is ever
// GPU-bound, and the honest way to ask is not to watch a show and hope it
// stutters. It is to take the ceiling off and see where the ceiling actually is.
//
// **rAF cannot answer it.** A browser paces `requestAnimationFrame` to the
// display, so a machine capable of 300fps and one barely holding 60 both report
// 60 through it. The page this opens runs free instead, drawing each flow for a
// real window of music and counting the frames that fit — see `visuals/bench.ts`
// for why the window is wall-clock rather than a frame count, and why the
// barrier is a one-pixel `readPixels` rather than the `gl.finish()` that does
// not work.
//
// Electron rather than the Chrome in `tools/visuals.ts`, for one reason: it is
// already a dependency and it is the same Chromium the app ships, so the number
// this prints is the number the app gets. A benchmark run on a different engine
// than the product is a benchmark of the wrong thing.

import { execSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mediaRoot, serveMedia } from '../visuals/server/media.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Anything passed straight through to the page, for probes rather than readings. */
const PACED = process.argv.includes('--paced');

const passed = ['bars', 'warmup', 'flows']
  .map((name) => {
    const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    return found ? `&${name}=${found.slice(name.length + 3)}` : '';
  })
  .join('');

/**
 * Which resolutions to sweep. 1920 is the show and is the default.
 *
 * `--sweep` takes the four that answer where this stops being free; an explicit
 * `--edges=` takes whatever you name.
 */
const named = process.argv.find((arg) => arg.startsWith('--edges='));
const EDGES = named
  ? named.slice('--edges='.length)
  : process.argv.includes('--sweep')
    ? '1280,1920,2560,3840'
    : '1920';
const runner = path.join(root, 'visuals', 'bench-dist', 'runner.cjs');

interface PacedResult {
  hz: number;
  late: number;
  lateShare: number;
  intervalP50: number;
  intervalP99: number;
  cpuP50: number;
  cpuP99: number;
  gpuP50: number | null;
  gpuP99: number | null;
  budgetShare: number;
}
interface FlowResult {
  id: string;
  name: string;
  work: number;
  frames: number;
  windowMs: number;
  msPerFrame: number;
  fps: number;
  paced: PacedResult | null;
  error: string | null;
}
interface Pass {
  width: number;
  height: number;
  tracks: number;
  mode: 'ceiling' | 'paced';
  bars: number;
  tempo: number;
  flows: FlowResult[];
}
interface BenchReport {
  renderer: string;
  passes: Pass[];
}

/**
 * Anything already drawing on this GPU, which would be measured as this rig.
 *
 * A show app or a second bench left open does not merely add noise — it takes
 * the GPU this is trying to measure, and the number comes out low in a way
 * nothing in the table would reveal. Warn rather than refuse: sometimes
 * measuring a contended machine is the point, and a benchmark that will not run
 * until the desktop is clean is a benchmark nobody runs.
 */
function contending(): string[] {
  try {
    const listed = execSync('ps -Ao comm=', { encoding: 'utf8' });
    const busy = new Set<string>();
    for (const line of listed.split('\n')) {
      if (line.includes('visual[flow]') && !line.includes('Helper')) busy.add('visual[flow]');
      if (line.includes('set[flow]') && !line.includes('Helper')) busy.add('set[flow]');
      if (/Ableton Live/.test(line)) busy.add('Ableton Live');
    }
    return [...busy];
  } catch {
    return [];
  }
}

const run = (cmd: string, args: string[], label: string): void => {
  const done = spawnSync(cmd, args, { stdio: 'inherit', cwd: root });
  if (done.status !== 0) throw new Error(`${label} failed`);
};

/**
 * The Electron main process, written out rather than kept as a file of its own.
 *
 * It exists only for the length of this command and it has no business in
 * `visuals/electron/`, which is the app. Two flags matter and they are the same
 * two the app sets: without them a window that loses focus mid-run is throttled,
 * and every flow after that reports a ceiling that is the throttle rather than
 * the machine.
 */
const MAIN = `
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

for (const flag of [
  'disable-background-timer-throttling',
  'disable-backgrounding-occluded-windows',
  'disable-renderer-backgrounding',
]) app.commandLine.appendSwitch(flag);

app.on('window-all-closed', () => app.quit());

const boot = async () => {
  const win = new BrowserWindow({
    // Big enough that the picture is worth looking at. The page fits its canvas
    // to this, and the drawing buffer is the resolution being measured rather
    // than the size of this window — the readout along the bottom says which.
    width: 1200,
    height: 715,
    show: !process.env.OPENFLOW_BENCH_HIDDEN,
    // A paced run is driven by requestAnimationFrame, and a window nothing can
    // see is given none — so it stays in front for the length of the run rather
    // than stalling the moment something is opened over it.
    alwaysOnTop: !!process.env.OPENFLOW_BENCH_PACED,
    webPreferences: { backgroundThrottling: false, offscreen: false },
  });
  // Anything the page says, said out loud. A benchmark that fails silently is
  // indistinguishable from one that is merely slow, which cost an afternoon.
  win.webContents.on('console-message', (...args) => {
    const event = args[0];
    const said = event && event.message !== undefined ? event.message : args[2];
    process.stderr.write('  page: ' + said + '\\n');
  });
  win.webContents.on('did-fail-load', (_e, code, described) => {
    process.stderr.write('  page failed to load: ' + code + ' ' + described + '\\n');
    app.exit(1);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    process.stderr.write('  page gone: ' + JSON.stringify(details) + '\\n');
    app.exit(1);
  });
  process.stderr.write('  loading ' + process.env.OPENFLOW_BENCH_URL + '\\n');
  await win.loadURL(process.env.OPENFLOW_BENCH_URL);

  // Polled rather than messaged: no preload, no IPC channel, and a page that
  // threw still has an answer to give.
  const started = Date.now();
  let said = null;
  for (;;) {
    const found = await win.webContents.executeJavaScript(
      'window.__bench ? JSON.stringify(window.__bench) : (window.__benchError || null)',
    );
    const progress = await win.webContents.executeJavaScript('window.__benchProgress || null');
    if (progress && progress !== said) {
      said = progress;
      process.stderr.write('  ' + progress + '\\n');
    }
    if (typeof found === 'string' && found.startsWith('{')) {
      process.stdout.write('OPENFLOW_BENCH ' + found + '\\n');
      break;
    }
    if (typeof found === 'string') {
      process.stderr.write('benchmark page failed: ' + found + '\\n');
      app.exit(1);
      return;
    }
    // Generous, because a full scheme at eight bars is minutes by design and a
    // --sweep of four resolutions is most of an hour. The flag to reach for when
    // that is too long is --bars, not this.
    if (Date.now() - started > 3600000) {
      process.stderr.write('benchmark timed out after an hour\\n');
      app.exit(1);
      return;
    }
    await new Promise((wake) => setTimeout(wake, 250));
  }
  app.exit(0);
};

// Every failure said out loud. An unhandled rejection inside whenReady leaves
// the app alive with no window doing anything and no message anywhere, which is
// indistinguishable from a slow benchmark until the timeout fires.
app.whenReady().then(boot).catch((err) => {
  process.stderr.write('  runner failed: ' + (err && err.stack || err) + '\\n');
  app.exit(1);
});
`;

/**
 * The paced table, which is the one that answers "do we make the budget".
 *
 * Ranked by how much of a refresh interval a frame took, worst first, because
 * that is the number a show lives or dies on. `late` beside it is what actually
 * happened: a flow can be cheap and still drop frames if something outside our
 * work is in the way, and the two columns disagreeing is the interesting case.
 */
function reportPaced(pass: Pass, nameWidth: number): void {
  const seconds = ((pass.bars * 4 * 60) / pass.tempo).toFixed(1);
  const ranked = [...pass.flows].sort(
    (a, b) => (b.paced?.budgetShare ?? 0) - (a.paced?.budgetShare ?? 0),
  );
  const hz = ranked[0]?.paced?.hz ?? 0;
  console.log(
    `${pass.width}x${pass.height}, ${pass.tracks} tracks playing, ` +
      `${pass.bars} bar${pass.bars === 1 ? '' : 's'} at ${pass.tempo}bpm ` +
      `(${seconds}s a flow) — PACED to the display at ${hz.toFixed(0)}Hz`,
  );
  console.log(
    `  ${pad('flow', nameWidth)}  ${padStart('work', 5)}  ${padStart('cpu p99', 8)}  ` +
      `${padStart('budget', 7)}  ${padStart('late', 7)}  ${padStart('gpu p99', 8)}`,
  );
  for (const flow of ranked) {
    const at = flow.paced;
    if (!at) continue;
    const line =
      `  ${pad(flow.name, nameWidth)}  ${padStart(String(flow.work), 5)}  ` +
      `${padStart(at.cpuP99.toFixed(2) + 'ms', 8)}  ` +
      `${padStart((at.budgetShare * 100).toFixed(1) + '%', 7)}  ` +
      `${padStart((at.lateShare * 100).toFixed(2) + '%', 7)}  ` +
      `${padStart(at.gpuP99 === null ? '—' : at.gpuP99.toFixed(2) + 'ms', 8)}`;
    console.log(flow.error ? `${line}   ${flow.error}` : line);
  }
  const worst = ranked[0];
  if (worst?.paced) {
    const at = worst.paced;
    const interval = at.hz > 0 ? 1000 / at.hz : 0;
    const spent = Math.max(at.cpuP99, at.gpuP99 ?? 0);
    console.log(
      `  worst: ${worst.name} took ${spent.toFixed(2)}ms of a ${interval.toFixed(1)}ms ` +
        `budget — ${(1 / at.budgetShare).toFixed(1)}x headroom, ` +
        `${(at.lateShare * 100).toFixed(2)}% of frames late`,
    );
    console.log(
      `  its medians: cpu ${at.cpuP50.toFixed(2)}ms, ` +
        `gpu ${at.gpuP50 === null ? '—' : at.gpuP50.toFixed(2) + 'ms'}\n`,
    );
  }
  console.log(
    'Paced draws one frame per display refresh, the way a show does, so every cost\n' +
      'paid per *presentation* rather than per draw is inside these numbers — the\n' +
      'unpaced run amortises those over thirty draws and cannot see them.\n' +
      'budget is the larger of cpu and gpu p99 against one refresh interval, because\n' +
      'the two overlap and the one that does not fit is the one that decides. late is\n' +
      'frames the display had to repeat. This mode cannot exceed the refresh rate and\n' +
      'is not trying to — it needs a visible window, since a hidden one gets no rAF.\n',
  );
}

/** Right-pad, so a column of names reads as a column. */
const pad = (text: string, width: number): string =>
  text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
const padStart = (text: string, width: number): string =>
  text.length >= width ? text : ' '.repeat(width - text.length) + text;

function report(found: BenchReport): void {
  console.log(`\nrenderer: ${found.renderer}\n`);

  const names = found.passes[0]?.flows ?? [];
  const nameWidth = Math.max(12, ...names.map((flow) => flow.name.length));

  for (const pass of found.passes) {
    if (pass.mode === 'paced') {
      reportPaced(pass, nameWidth);
      continue;
    }
    const ranked = [...pass.flows].sort((a, b) => a.fps - b.fps);
    const seconds = ((pass.bars * 4 * 60) / pass.tempo).toFixed(1);
    console.log(
      `${pass.width}x${pass.height}, ${pass.tracks} tracks playing, ` +
        `${pass.bars} bar${pass.bars === 1 ? '' : 's'} at ${pass.tempo}bpm ` +
        `(${seconds}s a flow)`,
    );
    console.log(
      `  ${pad('flow', nameWidth)}  ${padStart('work', 5)}  ${padStart('frames', 7)}  ` +
        `${padStart('ms', 7)}  ${padStart('fps', 7)}  ${padStart('gpu p50', 8)}`,
    );
    for (const flow of ranked) {
      const gpu = flow.paced?.gpuP50;
      const line =
        `  ${pad(flow.name, nameWidth)}  ${padStart(String(flow.work), 5)}  ` +
        `${padStart(String(flow.frames), 7)}  ` +
        `${padStart(flow.msPerFrame.toFixed(2), 7)}  ${padStart(flow.fps.toFixed(0), 7)}  ` +
        `${padStart(gpu === null || gpu === undefined ? '—' : gpu.toFixed(2) + 'ms', 8)}`;
      console.log(flow.error ? `${line}   ${flow.error}` : line);
    }
    const worst = ranked[0];
    // The slowest flow is the only one that matters. A rotation is only as fast
    // as the frame it is on when the frame is worst, and every flow in the
    // scheme is one somebody put in the rotation.
    //
    // **It does not claim headroom, and it used to.** Dividing this throughput
    // by 60 said Vortex had eighteen times a 60Hz budget; the paced run says it
    // has two and a half. Both numbers are real and they measure different
    // things — see the note below.
    if (worst) {
      console.log(
        `  slowest: ${worst.name} at ${worst.fps.toFixed(0)}fps throughput, ` +
          `gpu ${worst.paced?.gpuP50?.toFixed(2) ?? '—'}ms a frame\n`,
      );
    }
  }

  if (busy.length) {
    console.log(`Measured with ${busy.join(', ')} also on this GPU. These are floors, not ceilings.\n`);
  }
  if (found.passes.every((pass) => pass.mode === 'paced')) return;
  console.log(
    'Each flow is drawn for a real window of music — the beat comes off the wall\n' +
      'clock, so decoders and envelope followers run at the rate a show runs them —\n' +
      'and the score is how many frames fit. Not paced by requestAnimationFrame, so\n' +
      'these are ceilings rather than the display’s refresh rate.\n' +
      '\n' +
    'THROUGHPUT IS NOT HEADROOM. fps here is how many frames of this flow the GPU\n' +
      'will chew through in a second with several in flight at once. gpu p50 beside\n' +
      'it is how long *one* frame takes, and it is several times larger — Vortex\n' +
      'runs 1092fps with a 3.2ms frame, because the pipeline overlaps them. A show\n' +
      'presents one frame per refresh and cannot overlap, so the frame cost is what\n' +
      'its budget is spent on. Run --paced for the headroom number.\n' +
      'work is the compiler’s own prediction against its ceiling of 64 — it charges\n' +
      'only field, fractal, light and spread nodes, so 0 is ordinary. Where work and\n' +
      'ms disagree, the cost model in client/render/circuit.ts is what needs revisiting.\n',
  );
}

const busy = contending();
if (busy.length) {
  console.warn(
    `\nbenchmark: ${busy.join(', ')} ${busy.length > 1 ? 'are' : 'is'} running and sharing this GPU.\n` +
      'Every number below will read low. Quit them for a ceiling worth quoting.\n',
  );
}

run('npx', ['vite', 'build', '--config', 'visuals/vite.bench.config.ts'], 'bench build');

/**
 * The page, over HTTP rather than off disk.
 *
 * `file://` is its own opaque origin, and a module graph loaded there fails in
 * ways that set neither the result nor the error the runner polls for — the page
 * simply never starts, and the poll waits out its full timeout with nothing to
 * report. Serving it is three lines and removes the whole class. It is also what
 * the app does: `visuals/dist` is served at a stable origin on a show night, so
 * this measures the page in the arrangement it actually ships in.
 */
const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.css': 'text/css',
};

const dir = path.join(root, 'visuals', 'bench-dist');
const media = mediaRoot();
const serving = http.createServer((request, response) => {
  const asked = decodeURIComponent((request.url ?? '/').split('?')[0]);

  // **Media is served, and it has to be.** A `video` node only uploads a texture
  // when a decoded frame arrives, so with the real clock this now measures the
  // per-frame upload a show actually pays — and it can only do that if the file
  // is there. Against the old frame-counted window it barely mattered; a
  // fifteen-second window is four hundred frames of decode that would otherwise
  // be four hundred 404s.
  if (asked.startsWith('/media/')) {
    if (serveMedia(request, response, media, asked.slice('/media/'.length))) return;
    response.writeHead(404).end('media not found');
    return;
  }

  const file = path.join(dir, asked === '/' ? 'bench.html' : asked);
  // Never outside the build. The page asks for its own assets and nothing else.
  if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  response.end(fs.readFileSync(file));
});
await new Promise<void>((ready) => serving.listen(0, '127.0.0.1', ready));
const port = (serving.address() as { port: number }).port;
const url =
  `http://127.0.0.1:${port}/bench.html?edges=${EDGES}${passed}` + (PACED ? '&paced=1' : '');

fs.writeFileSync(runner, MAIN);

/**
 * `spawn`, and emphatically not `spawnSync`.
 *
 * The server above lives in *this* process, and `spawnSync` blocks this
 * process's event loop until the child exits — so the page's request for its own
 * HTML would never be answered, the window would sit on a blank document
 * forever, and the run would look exactly like a benchmark that is merely slow.
 * It cost an afternoon. A server and a synchronous wait cannot share a process.
 */
const collected = await new Promise<string>((done, fail) => {
  const child = spawn(path.join(root, 'node_modules', '.bin', 'electron'), [runner], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      OPENFLOW_BENCH_URL: url,
      ...(PACED ? { OPENFLOW_BENCH_PACED: '1' } : {}),
    },
    // stdout is captured for the payload; stderr goes straight through so a
    // failure inside the window is readable rather than swallowed.
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
  });
  child.on('error', fail);
  child.on('close', () => done(out));
});

serving.close();

const line = collected
  .split('\n')
  .find((each) => each.startsWith('OPENFLOW_BENCH '));

if (!line) {
  console.error('benchmark: the window produced no result');
  process.exit(1);
}

report(JSON.parse(line.slice('OPENFLOW_BENCH '.length)) as BenchReport);
