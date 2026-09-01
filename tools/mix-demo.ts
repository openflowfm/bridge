#!/usr/bin/env node
// Serve mix[flow]'s window over plain HTTP, so it can be looked at on a device
// that cannot run Electron — a phone on the same WiFi, a tablet, another laptop.
//
//   npm run demo:mix -- --library=/path/to/a/library
//   npm run demo:mix -- --library=… --port=8080
//
// **The window is the real build. The bridge is a stub, and it is the only fake
// thing here.** Everything the renderer does with audio — fetching the stems,
// decoding them, drawing the peaks, playing and mixing them — is the shipping
// code path, because the library base is something the main process *tells* the
// renderer rather than something the renderer assumes. Swap the teller and the
// same page works over HTTP.
//
// What the stub cannot do is anything that needs a process: importing, choosing
// a folder, separating and transcribing all answer honestly that they need the
// app. This is for looking at the window, not for using it.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS } from '../mix/electron/models.ts';
import { read } from '../mix/electron/manifest.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name: string, fallback = ''): string => {
  const found = process.argv.find((each) => each.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const LIBRARY = path.resolve(arg('library'));
const PORT = Number(arg('port', '8770'));
const DIST = path.join(root, 'mix', 'dist');

if (!arg('library')) throw new Error('demo:mix needs --library=/path/to/a/library');
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error(`no build at ${DIST} — run \`npm run build:mix\` first`);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.opus': 'audio/ogg',
};

/** The same containment rule the app's own mount uses. */
const within = (base: string, rel: string): string | null => {
  const file = path.join(base, path.normalize(rel));
  return file === base || file.startsWith(base + path.sep) ? file : null;
};

const manifest = await read(LIBRARY);
const withStems = manifest.tracks.filter((t) => t.stems);

/**
 * The stub, injected ahead of the app's own script.
 *
 * Written as a string rather than bundled because it is twenty lines of shim
 * and giving it a build step would make it look like part of the app.
 */
const bridge = `window.openflow = {
  demucs: async () => ({ ok: false, says: 'hosted preview — no separator here', workspace: '—' }),
  library: {
    read: async () => (${JSON.stringify({ root: LIBRARY, tracks: manifest.tracks })}),
    choose: async () => { throw new Error('needs the app'); },
    add: async () => ({ root: null, tracks: [], added: 0, refused: ['importing needs the app'] }),
    reveal: async () => {},
    base: async () => '/library',
  },
  separate: {
    models: async () => (${JSON.stringify(MODELS)}),
    busy: async () => null,
    run: async (ask) => ({ ok: false, trackId: ask.trackId, says: 'separating needs the app — this is a hosted preview of the window', cancelled: false }),
    cancel: async () => {},
    onProgress: () => () => {},
    onFinished: () => () => {},
  },
  transcribe: {
    busy: async () => null,
    run: async (ask) => ({ ok: false, trackId: ask.trackId, says: 'transcribing needs the app — this is a hosted preview of the window', cancelled: false }),
    cancel: async () => {},
    reveal: async () => {},
    onProgress: () => () => {},
    onFinished: () => () => {},
  },
};`;

/**
 * Read per request, not once at startup.
 *
 * A build writes hashed asset names into this file, so a page held in memory
 * across a rebuild points at a bundle that no longer exists — a blank window
 * and a 404 in a console nobody is looking at, on a phone. Rebuilding while
 * this is running is the normal case, so it has to survive it.
 */
const page = (): string =>
  fs
    .readFileSync(path.join(DIST, 'index.html'), 'utf8')
    .replace('</head>', '  <script src="/demo-bridge.js"></script>\n  </head>');

const serving = http.createServer((request, response) => {
  const rel = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);

  const send = (body: Buffer | string, type: string, status = 200) => {
    response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(body);
  };

  if (rel === '/' || rel === '/index.html') return send(page(), TYPES['.html']);
  if (rel === '/demo-bridge.js') return send(bridge, TYPES['.js']);

  if (rel.startsWith('/library/')) {
    let file = within(LIBRARY, rel.slice('/library/'.length));
    if (!file) return send('forbidden', 'text/plain', 403);
    // A hosted preview is going over WiFi to a phone, and four float32 stems of
    // a four-minute track are a third of a gigabyte. A library prepared for this
    // may hold compressed stems under the same names, so a `.wav` that is not
    // there falls through to whatever is — the decoder sniffs the bytes and does
    // not care what the URL claimed. Only true of this rig; the app serves what
    // it wrote.
    if (!fs.existsSync(file) && file.endsWith('.wav')) {
      const swap = ['.m4a', '.mp3', '.opus', '.flac'].map((e) => file!.replace(/\.wav$/, e));
      file = swap.find((each) => fs.existsSync(each)) ?? file;
    }
    try {
      return send(fs.readFileSync(file), TYPES[path.extname(file)] ?? 'application/octet-stream');
    } catch {
      return send('not found', 'text/plain', 404);
    }
  }

  const file = within(DIST, rel);
  if (!file) return send('forbidden', 'text/plain', 403);
  try {
    send(fs.readFileSync(file), TYPES[path.extname(file)] ?? 'application/octet-stream');
  } catch {
    send('not found', 'text/plain', 404);
  }
});

/** The address another device on the WiFi can actually reach. */
const lan = (): string => {
  for (const each of Object.values(os.networkInterfaces()).flat()) {
    if (each && each.family === 'IPv4' && !each.internal) return each.address;
  }
  return '127.0.0.1';
};

serving.listen(PORT, '0.0.0.0', () => {
  console.log(`\nmix[flow], hosted from ${LIBRARY}`);
  console.log(`  ${manifest.tracks.length} track(s), ${withStems.length} with stems\n`);
  console.log(`  on this machine   http://127.0.0.1:${PORT}/`);
  console.log(`  on the WiFi       http://${lan()}:${PORT}/\n`);
  console.log('The window is the real build; the bridge is a stub. Ctrl-C to stop.');
});
