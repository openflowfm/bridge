#!/usr/bin/env node
// `npm run frames` — draw flows through the real renderer and write the PNGs.
//
// The benchmark next door answers how *fast* a flow draws. This answers what it
// looks like, which turned out to be the harder question to ask honestly: every
// hand-built harness written for it so far has been wrong in a way that flatters
// or libels the picture, because a harness that compiles the flow shader itself
// skips the output stage, feeds the wrong uniform for the meter, and is looked
// at through a downscaled JPEG screenshot that cannot show banding.
//
// So: the real `Compositor`, the real `Show`, the real output stage, at the real
// resolution, written to PNG files on disk. Electron for the same reason the
// benchmark uses it — it is the Chromium the app ships, so the picture this
// writes is the picture the app draws.
//
//   npm run frames -- --flows=halo,cage --at=0,1,2,3 --size=1920x1080
//   npm run frames -- --flows=halo --at=2 --size=2560x1440 --out=/tmp/look
//
// Files land in `visuals/frames-out/` unless `--out` says otherwise, one PNG per
// flow and beat, plus a `stats.json` beside them.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXAMPLES, merge } from '../visuals/server/scheme.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name: string, fallback: string): string => {
  const found = process.argv.find((each) => each.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const SIZE = arg('size', '1280x720');
const [WIDTH, HEIGHT] = SIZE.split('x').map(Number);
const FLOWS = arg('flows', '');
const AT = arg('at', '0,1,2,3');
const COLORWAY = arg('colorway', '');
const SETTLE = arg('settle', '90');
const OUT = path.resolve(arg('out', path.join(root, 'visuals', 'frames-out')));
/** `examples`, or the id of one of the user's own schemes. */
const SCHEME = arg('scheme', 'examples');

// Merged here rather than in the page: `merge` is the one door every scheme
// comes through, and a tool that skipped it would be drawing something the app
// never would.
const chosen =
  SCHEME === 'examples'
    ? EXAMPLES
    : merge(
        JSON.parse(
          fs.readFileSync(
            path.join(os.homedir(), '.openflow', 'visuals', 'schemes', `${SCHEME}.json`),
            'utf8',
          ),
        ),
      );

interface FrameStat {
  flow: string;
  beat: number;
  lum: number;
  black: number;
  white: number;
  peak: number;
  terrace: number;
}
interface FramesReport {
  renderer: string;
  width: number;
  height: number;
  stats: FrameStat[];
  errors: string[];
}

const built = spawnSync(
  path.join(root, 'node_modules', '.bin', 'vite'),
  ['build', '--config', 'vite.frames.config.ts'],
  { cwd: path.join(root, 'visuals'), stdio: 'inherit' },
);
if (built.status !== 0) {
  console.error('frames: the page did not build');
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.css': 'text/css',
};
const dir = path.join(root, 'visuals', 'frames-dist');

let written = 0;
const serving = http.createServer((request, response) => {
  const asked = decodeURIComponent((request.url ?? '/').split('?')[0]);

  // The page hands each finished frame back as a data URL rather than trying to
  // download it: a renderer process cannot write a file, and a screenshot of the
  // window would be the compressed, downscaled picture this tool exists to stop
  // looking at.
  if (request.method === 'POST' && asked === '/write') {
    const query = new URLSearchParams((request.url ?? '').split('?')[1] ?? '');
    const name = (query.get('name') ?? `frame-${written}`).replace(/[^\w@.-]+/g, '_');
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const comma = body.indexOf(',');
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(body.slice(comma + 1), 'base64'));
      written += 1;
      response.writeHead(204).end();
    });
    return;
  }

  if (asked === '/scheme.json') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(chosen));
    return;
  }

  const file = path.join(dir, asked === '/' ? 'frames.html' : asked);
  if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
  });
  response.end(fs.readFileSync(file));
});
await new Promise<void>((ready) => serving.listen(0, '127.0.0.1', ready));
const port = (serving.address() as { port: number }).port;

const query = new URLSearchParams({ w: String(WIDTH), h: String(HEIGHT), at: AT, settle: SETTLE });
if (FLOWS) query.set('flows', FLOWS);
if (COLORWAY) query.set('colorway', COLORWAY);
const url = `http://127.0.0.1:${port}/frames.html?${query}`;

const runner = path.join(root, 'visuals', 'frames-dist', 'runner.cjs');
fs.writeFileSync(
  runner,
  `
const { app, BrowserWindow } = require('electron');
for (const flag of [
  'disable-background-timer-throttling',
  'disable-backgrounding-occluded-windows',
  'disable-renderer-backgrounding',
]) app.commandLine.appendSwitch(flag);
app.on('window-all-closed', () => app.quit());
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200, height: 720,
    show: !process.env.OPENFLOW_FRAMES_HIDDEN,
    webPreferences: { backgroundThrottling: false, offscreen: false },
  });
  win.webContents.on('console-message', (...a) => {
    const e = a[0];
    process.stderr.write('  page: ' + (e && e.message !== undefined ? e.message : a[2]) + '\\n');
  });
  win.webContents.on('did-fail-load', (_e, code, said) => {
    process.stderr.write('  page failed to load: ' + code + ' ' + said + '\\n');
    app.exit(1);
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    process.stderr.write('  page gone: ' + JSON.stringify(d) + '\\n');
    app.exit(1);
  });
  await win.loadURL(process.env.OPENFLOW_FRAMES_URL);
  for (;;) {
    const report = await win.webContents.executeJavaScript('window.__frames || null');
    if (report) { process.stdout.write('OPENFLOW_FRAMES ' + JSON.stringify(report) + '\\n'); break; }
    const failed = await win.webContents.executeJavaScript('window.__framesError || null');
    if (failed) { process.stderr.write(failed + '\\n'); app.exit(1); return; }
    await new Promise((r) => setTimeout(r, 250));
  }
  app.quit();
});
`,
);

// `spawn`, never `spawnSync`: the server above is in this process, and blocking
// its event loop means the page's request for its own HTML is never answered.
// The window then sits on a blank document forever and it looks like a slow
// render rather than a deadlock. The benchmark next door documents the same trap.
const collected = await new Promise<string>((done, fail) => {
  const child = spawn(path.join(root, 'node_modules', '.bin', 'electron'), [runner], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      OPENFLOW_FRAMES_URL: url,
    },
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

const line = collected.split('\n').find((each) => each.startsWith('OPENFLOW_FRAMES '));
if (!line) {
  console.error('frames: the window produced no result');
  process.exit(1);
}
const report = JSON.parse(line.slice('OPENFLOW_FRAMES '.length)) as FramesReport;
fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify(report, null, 2));

const pad = (text: string, width: number) => text.padStart(width);
console.log(`\n${report.width}x${report.height} on ${report.renderer} — scheme ${SCHEME}`);
console.log(
  `${'flow'.padEnd(10)}${pad('beat', 6)}${pad('lum', 8)}${pad('black', 8)}${pad('white', 8)}` +
    `${pad('peak', 6)}${pad('terrace', 9)}`,
);
for (const stat of report.stats) {
  console.log(
    `${stat.flow.padEnd(10)}${pad(String(stat.beat), 6)}${pad(stat.lum.toFixed(1), 8)}` +
      `${pad(`${(stat.black * 100).toFixed(1)}%`, 8)}${pad(`${(stat.white * 100).toFixed(2)}%`, 8)}` +
      `${pad(String(stat.peak), 6)}${pad(stat.terrace.toFixed(1), 9)}`,
  );
}
for (const said of report.errors) console.error(`  ${said}`);
console.log(`\n${written} frames in ${OUT}`);
