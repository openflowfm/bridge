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
const ROLES_FILE = path.join(__dirname, 'roles.json');

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

/**
 * A non-empty description of a thrown value.
 *
 * `||` rather than `??`, because an Error carrying an empty message is exactly
 * as untraceable as one carrying none and `??` lets `''` through. An error that
 * reaches the UI as "color: " with nothing after it costs more time than the
 * original bug.
 */
function describe(e: unknown): string {
  const m = (e as Error)?.message;
  if (typeof m === 'string' && m !== '') return m;
  const s = String(e);
  if (s && s !== 'undefined' && s !== 'null' && s !== '[object Object]') return s;
  return 'unknown bridge error — see the Max window';
}

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

  // The role vocabulary. Lives beside the palette, and here rather than in
  // localStorage for two reasons: the UI is served from two origins (:5173 in
  // dev, :17800 shipped) so browser storage would quietly diverge between them,
  // and a cache clear before a gig shouldn't cost you your color scheme.
  //
  // Unlike the palette, an empty vocabulary is a perfectly good steady state —
  // it's what a fresh install has — so a missing file answers 200 with an empty
  // list rather than 404. There is nothing to derive and nothing to retry.
  if (rel === '/roles.json') {
    fs.readFile(ROLES_FILE, (err, buf) => {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(err ? '{"roles":[]}' : buf);
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
      const message = `${m.type}: ${describe(e)}`;
      Max.post(`request failed — ${message}`);
      send(ws, { type: 'error', id: m.id, message });
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
      const sceneOps = Array.isArray(m.sceneOps) ? m.sceneOps : [];
      const reqId = track(ws, m);
      try {
        await Max.setDict('bsv_ops', { ops, sceneOps });
      } catch (e) {
        // Max rejects setDict for a dict that doesn't exist yet, and does it with
        // an empty message — which is how this arrived as "apply: Error" and
        // nothing else. lom.ts creates bsv_ops in ensureDicts() on init for
        // exactly this reason, so if you're reading this, suspect that ran late
        // or not at all.
        pending.delete(reqId);
        throw new Error(
          `could not stage ${ops.length + sceneOps.length} ops into bsv_ops — ` +
            `${describe(e)}. The dict must exist before Node can write it; ` +
            `lom.ts creates it on init.`,
        );
      }
      Max.outlet('apply', reqId, 'bsv_ops');
      break;
    }
    // Reordering scenes. Shares `bsv_ops` with apply — one write is in flight at
    // a time and lom.ts refuses either while the other is running, so there's no
    // second dict to keep alive. It does NOT share the `apply` message: this one
    // deletes scenes, and the two paths should not be one typo apart.
    case 'move': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      const plan = m.plan;
      const create = Array.isArray(plan?.create) ? plan.create : [];
      const steps = Array.isArray(plan?.steps) ? plan.steps : [];
      const remove = Array.isArray(plan?.remove) ? plan.remove : [];
      // The same check lom.ts makes, made earlier so a malformed plan never gets
      // as far as Live. A plan that deletes more than it creates shrinks the set
      // on every drag.
      if (!create.length || create.length !== remove.length) {
        return send(ws, {
          type: 'error',
          id: m.id,
          message:
            `refusing a move that creates ${create.length} scenes and deletes ` +
            `${remove.length} — the plan is malformed`,
        });
      }
      const reqId = track(ws, m);
      try {
        await Max.setDict('bsv_ops', { plan: { create, steps, remove } });
      } catch (e) {
        pending.delete(reqId);
        throw new Error(
          `could not stage a move of ${create.length} scenes into bsv_ops — ` +
            `${describe(e)}. The dict must exist before Node can write it; ` +
            `lom.ts creates it on init.`,
        );
      }
      Max.outlet('move', reqId, 'bsv_ops');
      break;
    }
    case 'palette': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      Max.outlet('palette', track(ws, m));
      break;
    }
    // Pure file I/O — no LOM involved, so no lomReady gate. The roles
    // themselves live in the scene names inside the set; this file is only the
    // vocabulary and its colors.
    case 'saveRoles': {
      const roles = (Array.isArray(m.roles) ? m.roles : []).filter(
        (r): r is BSV.Role =>
          !!r && typeof r.name === 'string' && r.name.trim() !== '' &&
          typeof r.colorIndex === 'number' && Number.isFinite(r.colorIndex),
      );
      // Write-then-rename. A half-written file here would parse as invalid JSON
      // and the UI would come up with no vocabulary at all — the same shape of
      // failure the degenerate palette cache caused, and just as confusing.
      const tmp = `${ROLES_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ roles }, null, 2));
      fs.renameSync(tmp, ROLES_FILE);
      Max.post(`roles: ${roles.length} saved`);
      send(ws, { type: 'rolesSaved', id: m.id, count: roles.length });
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

Max.addHandler('move_progress', (reqId: number, done: number, total: number) => {
  const req = pending.get(reqId);
  send(req?.ws, { type: 'progress', id: req?.clientId, done, total });
});

Max.addHandler('move_done', async (reqId: number, dictName: string, ms: number) => {
  const req = pending.get(reqId);
  pending.delete(reqId);
  const r: {
    created: number; copied: number; removed: number;
    failed: number; undoStep: boolean;
  } = await Max.getDict(dictName);
  Max.post(
    `move: ${r.created} scenes created, ${r.copied} clips copied, ` +
      `${r.removed} deleted, ${r.failed} failed, ${ms}ms` +
      (r.undoStep ? ' (one undo step)' : ' (NOT undoable in Live)'),
  );
  send(req?.ws, { type: 'moved', id: req?.clientId, lomMs: ms, ...r });
  // Structural, so every other client's scene indexes just became wrong. This
  // is the one change where a stale grid is actively dangerous rather than
  // merely out of date — a click lands on a different scene than it looks like.
  broadcast({ type: 'changed', kind: 'moved' });
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

Max.addHandler('err', (reqId: number, ...rest: unknown[]) => {
  const req = pending.get(reqId);
  pending.delete(reqId);
  // Max drops an empty symbol, so the message atom may not arrive at all; and a
  // message lom failed to quote arrives split across several atoms.
  const joined = rest.map(String).join(' ').trim();
  const message = joined !== '' ? joined : 'LOM failed without a message';
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
