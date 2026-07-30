// bridge.ts — compiled to bridge/bridge.js and run by Node for Max.
//
// Owns the HTTP + WebSocket server. Knows nothing about the Live Object Model;
// it just relays coarse-grained requests to lom.ts and streams results back.
// Serving the UI from here is deliberate: the whole app ships as one .amxd plus
// this folder, with no packaging, signing or updater.
//
// Protocol types come from the global BSV namespace rather than an import, so
// this can emit to a flat file outside its own rootDir.

import Max = require('max-api');
import http = require('node:http');
import fs = require('node:fs');
import path = require('node:path');
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.BSV_PORT) || 17800;
const HOST = '127.0.0.1';
const WS_PATH = '/ws';
const PUBLIC = path.join(__dirname, 'public');
const PALETTE_FILE = path.join(__dirname, 'palette.json');

interface Pending {
  ws: WebSocket;
  type: BSV.RequestType;
  clientId?: number;
  started: number;
}

let lomReady = false;
let nextReqId = 1;
const pending = new Map<number, Pending>();

// --- http -------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** The cache file's contents if they could plausibly be Live's palette, else null. */
function usablePalette(buf: Buffer): string | null {
  try {
    const p = JSON.parse(buf.toString()) as BSV.Palette;
    if (!Array.isArray(p.colors) || p.colors.length < 2) return null;
    if (new Set(p.colors).size < 2) return null;
    return buf.toString();
  } catch {
    return null; // truncated or hand-edited
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';

  // The cached palette lives beside the source, not in public/.
  //
  // A degenerate cache is treated as no cache at all. A broken sweep once wrote
  // a one-entry black palette here, and because the file existed and parsed, the
  // UI showed a single swatch forever rather than "not extracted yet" — the bad
  // data looked exactly like data. Live's palette is dozens of colors, so
  // anything under two is a failure to serve, not a palette.
  if (rel === '/palette.json') {
    fs.readFile(PALETTE_FILE, (err, buf) => {
      const body = err ? null : usablePalette(buf);
      res.writeHead(body ? 200 : 404, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(body ?? '{"count":0,"colors":[]}');
    });
    return;
  }

  const file = path.join(PUBLIC, path.normalize(rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, path: WS_PATH });

function send(ws: WebSocket | undefined, event: BSV.Event): void {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(event));
}

function broadcast(event: BSV.Event): void {
  const s = JSON.stringify(event);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(s);
}

wss.on('connection', (ws: WebSocket) => {
  Max.post(`client connected (${wss.clients.size} total)`);
  send(ws, { type: 'status', lomReady });

  ws.on('message', async (raw) => {
    let m: BSV.Request;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: 'error', message: 'bad json' });
    }
    try {
      await handle(ws, m);
    } catch (e) {
      send(ws, { type: 'error', id: m.id, message: String((e as Error).message ?? e) });
    }
  });

  ws.on('close', () => Max.post(`client disconnected (${wss.clients.size} left)`));
});

function track(ws: WebSocket, m: BSV.Request): number {
  const reqId = nextReqId++;
  pending.set(reqId, { ws, type: m.type, clientId: m.id, started: Date.now() });
  return reqId;
}

async function handle(ws: WebSocket, m: BSV.Request): Promise<void> {
  switch (m.type) {
    case 'snapshot': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      Max.outlet('snapshot', track(ws, m));
      break;
    }
    case 'apply': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      const ops = Array.isArray(m.ops) ? m.ops : [];
      const reqId = track(ws, m);
      await Max.setDict('bsv_ops', { ops });
      Max.outlet('apply', reqId, 'bsv_ops');
      break;
    }
    case 'palette': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      Max.outlet('palette', track(ws, m));
      break;
    }
    case 'observe':
      Max.outlet('observe', m.on ? 1 : 0);
      break;
    // Playback is fire-and-forget: no reqId, no pending entry, no reply. The
    // caller's feedback is the play_state push, and awaiting an ack would only
    // add latency to the one thing that has to feel instant. Both wire types
    // collapse onto one Max message — see `playback` in lom.ts.
    case 'launch': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      const g = m.target;
      if (g.kind === 'clip') Max.outlet('playback', 'clip', g.t, g.s);
      else if (g.kind === 'scene') Max.outlet('playback', 'scene', g.s, 0);
      else Max.outlet('playback', 'song', 0, 0);
      break;
    }
    case 'stop': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      const g = m.target;
      if (g.kind === 'track') Max.outlet('playback', 'stopTrack', g.t, 0);
      else if (g.kind === 'clips') Max.outlet('playback', 'stopClips', 0, 0);
      else Max.outlet('playback', 'stopSong', 0, 0);
      break;
    }
    case 'watchPlay':
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      Max.outlet('watch_play', m.on ? 1 : 0);
      break;
    case 'ping':
      send(ws, { type: 'pong', id: m.id });
      break;
    default:
      send(ws, {
        type: 'error',
        id: (m as { id?: number }).id,
        message: `unknown type: ${(m as { type: string }).type}`,
      });
  }
}

// --- messages from lom.ts --------------------------------------------

Max.addHandler('ready', () => {
  lomReady = true;
  Max.post('LOM ready');
  broadcast({ type: 'status', lomReady: true });
});

Max.addHandler('snapshot_done', async (reqId: number, dictName: string, dictMs: number) => {
  const req = pending.get(reqId);
  pending.delete(reqId);
  const t0 = Date.now();
  const data: BSV.Snapshot = await Max.getDict(dictName);
  const hostMs = Date.now() - t0;
  const t = data.timings;
  Max.post(
    `snapshot: ${data.clipCount} clips in ${data.ms}ms lom ` +
      `(tracks ${t.tracks} · scenes ${t.scenes} · ${t.slotsScanned} slots ${t.slots} · clips ${t.clips}) ` +
      `+ ${dictMs}ms dict + ${hostMs}ms host`,
  );
  const event: BSV.Event = { type: 'snapshot', id: req?.clientId, dictMs, hostMs, data };
  if (req?.ws) send(req.ws, event);
  else broadcast(event);
});

Max.addHandler('apply_progress', (reqId: number, done: number, total: number) => {
  const req = pending.get(reqId);
  send(req?.ws, { type: 'progress', id: req?.clientId, done, total });
});

Max.addHandler('apply_done', async (reqId: number, dictName: string, ms: number) => {
  const req = pending.get(reqId);
  pending.delete(reqId);
  const result: BSV.ApplyResult = await Max.getDict(dictName);
  Max.post(`apply: ${result.applied} written, ${result.skipped} skipped, ${ms}ms`);
  send(req?.ws, { type: 'applied', id: req?.clientId, lomMs: ms, ...result });
  broadcast({ type: 'changed', kind: 'applied' });
});

Max.addHandler('palette_done', async (reqId: number, dictName: string) => {
  const req = pending.get(reqId);
  pending.delete(reqId);
  const p: BSV.Palette = await Max.getDict(dictName);
  // Deriving the palette costs a scratch scene, so only ever do it once.
  try {
    fs.writeFileSync(PALETTE_FILE, JSON.stringify(p, null, 2));
    Max.post(`palette: ${p.count} colors extracted and cached`);
  } catch (e) {
    Max.post(`palette: extracted but could not cache — ${(e as Error).message}`);
  }
  send(req?.ws, { type: 'palette', id: req?.clientId, ...p });
  broadcast({ type: 'paletteUpdated' });
});

Max.addHandler('changed', (kind: string) => broadcast({ type: 'changed', kind }));

// Flat atoms, not a Dict: this pushes on every play-state change, and a global
// dict name would race itself. See the note above `playStateAtoms` in lom.ts.
// Shape: isPlaying, then (playing, fired) per track in track order.
Max.addHandler('play_state', (...args: number[]) => {
  const tracks: BSV.TrackPlayState[] = [];
  for (let i = 1; i + 1 < args.length; i += 2) {
    tracks.push({ playing: Number(args[i]), fired: Number(args[i + 1]) });
  }
  broadcast({ type: 'playState', isPlaying: Number(args[0]) === 1, tracks });
});

Max.addHandler('err', (reqId: number, message: string) => {
  const req = pending.get(reqId);
  pending.delete(reqId);
  Max.post(`LOM error: ${message}`);
  const event: BSV.Event = { type: 'error', id: req?.clientId, message };
  // Untracked failures — a launch, a stop, an observer callback — have no
  // pending request to answer, and dropping them is how a silent bug hides.
  // With no id, no waiter is rejected; the client just logs it.
  if (req?.ws) send(req.ws, event);
  else broadcast(event);
});

Max.addHandler('pong', () => {});

// --- dev: live reload -------------------------------------------------
// Vite's own HMR covers the dev server. This covers the built output being
// served straight out of public/.

let reloadTimer: NodeJS.Timeout | undefined;
try {
  fs.watch(PUBLIC, { recursive: true }, () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      Max.post('public/ changed — reloading clients');
      broadcast({ type: 'reload' });
    }, 120); // editors emit several events per save
  });
} catch (e) {
  Max.post(`could not watch public/ — live reload off (${(e as Error).message})`);
}

// --- lifecycle --------------------------------------------------------

// Both listeners are required: WebSocketServer re-emits the http server's error
// on itself, and an unhandled 'error' event takes down the whole script.
let reportedError = false;
function onServerError(e: NodeJS.ErrnoException): void {
  if (reportedError) return; // both listeners fire for the same failure
  reportedError = true;
  if (e.code === 'EADDRINUSE') {
    Max.post(
      `port ${PORT} already in use — another copy of this device is probably loaded. ` +
        `Delete the duplicate, or set BSV_PORT.`,
    );
  } else {
    Max.post(`server error: ${e.message}`);
  }
}
server.on('error', onServerError);
wss.on('error', onServerError);

server.listen(PORT, HOST, () => {
  Max.post(`Session Bridge listening on http://${HOST}:${PORT}`);
  Max.outlet('serving'); // drives the device's status line; routed off before lom
  Max.outlet('hello'); // whichever side is late drives the handshake
});

function shutdown(): void {
  try {
    for (const ws of wss.clients) ws.terminate();
    server.close();
  } catch {
    /* already down */
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
