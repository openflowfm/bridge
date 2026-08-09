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
import os = require('node:os');
import path = require('node:path');
import { WebSocketServer, WebSocket } from 'ws';
import { derive } from '../../core/src/derive';
import { SCENE_PATTERNS } from '../../core/src/namePattern';
import { canApplyDelta, mergeRows } from '../../core/src/snapshotDelta';

const PORT = Number(process.env.BSV_PORT) || 17800;
const HOST = '127.0.0.1';
const WS_PATH = '/ws';
const PUBLIC = path.join(__dirname, 'public');

/**
 * Where older installs kept role configuration.
 *
 * Deliberately **not** `__dirname`. The device is meant to ship as a single
 * frozen `.amxd`, and Live unpacks a frozen device to a temporary location — so
 * anything written beside the script is written somewhere disposable. Even
 * unfrozen, `__dirname` ties your color scheme to one copy of one folder, and an
 * upgrade that replaces the folder silently takes the vocabulary with it.
 *
 * New state is stored in the device's parameter-enabled `pattr` and therefore
 * in the .als itself. This directory remains read-only migration input.
 */
function stateDir(): string {
  const override = process.env.BSV_STATE_DIR;
  if (override) return override;
  const home = os.homedir();
  return process.platform === 'win32'
    ? path.join(
        process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
        'Session Bridge',
      )
    : path.join(home, 'Library', 'Application Support', 'Session Bridge');
}

const STATE = stateDir();

/**
 * The old machine-wide vocabulary, read only when a device has no embedded
 * state yet.
 */
const DEFAULT_ROLES_FILE = path.join(STATE, 'roles.json');

/** The old per-project vocabulary filename. */
const VOCABULARY = 'bsv.json';

/**
 * Where the open set lives, used only to find a legacy bsv.json during the
 * first migration into device state.
 */
let setDir = '';
let setName = '';

/**
 * The legacy vocabulary file for the open set, or the machine-wide one.
 *
 * The directory is checked when migration runs rather than trusted blindly,
 * because the answer is only as good as the string Live handed us: LiveAPI
 * returns symbol properties as space-separated atoms, so `gstr` rebuilds a path
 * containing spaces by joining on a single space, and a path with a double space
 * in it comes back subtly wrong. A wrong-but-plausible directory is exactly the
 * silent failure this project avoids — so an unresolvable one falls back to the
 * machine-wide file and says so, rather than quietly writing a `bsv.json`
 * somewhere nobody will look.
 */
let reportedMissingDir = '';

function legacyVocabularyFile(): string {
  if (!setDir) return DEFAULT_ROLES_FILE;
  if (!fs.existsSync(setDir)) {
    // Report once per folder during migration.
    if (reportedMissingDir !== setDir) {
      reportedMissingDir = setDir;
      Max.post(`set folder does not exist, using the machine-wide roles: ${setDir}`);
    }
    return DEFAULT_ROLES_FILE;
  }
  return path.join(setDir, VOCABULARY);
}

/**
 * The vocabulary to migrate: this set's, else the machine-wide one as a seed.
 *
 * A set with no `bsv.json` falls back to whatever the older install kept
 * machine-wide. Neither source is written again after migration.
 */
function readLegacyVocabulary(): Buffer | null {
  for (const file of [
    legacyVocabularyFile(),
    DEFAULT_ROLES_FILE,
    path.join(__dirname, 'roles.json'),
  ]) {
    try {
      return fs.readFileSync(file);
    } catch {
      // missing is the ordinary case for both, so try the next one
    }
  }
  return null;
}

// --- device state ----------------------------------------------------

/** Keep malformed or stale state from reaching React or being written back. */
function cleanRoles(value: unknown): BSV.Role[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (r): r is BSV.Role =>
      !!r && typeof r === 'object' &&
      typeof (r as BSV.Role).name === 'string' &&
      (r as BSV.Role).name.trim() !== '' &&
      Number.isInteger((r as BSV.Role).colorIndex) &&
      (r as BSV.Role).colorIndex >= -1,
  ).map((r) => ({ name: r.name.trim(), colorIndex: r.colorIndex }));
}

function cleanAllowedColors(value: unknown): number[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value.filter((v): v is number => Number.isInteger(v) && v >= 0),
  )].sort((a, b) => a - b);
}

function normalizeDeviceState(value: unknown): BSV.DeviceState | null {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) {
    return null;
  }
  const source = value as { roles?: unknown; allowedColors?: unknown };
  const state: BSV.DeviceState = { version: 1, roles: cleanRoles(source.roles) };
  if (Object.prototype.hasOwnProperty.call(source, 'allowedColors')) {
    state.allowedColors = cleanAllowedColors(source.allowedColors);
  }
  return state;
}

function encodeDeviceState(state: BSV.DeviceState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

function decodeDeviceState(encoded: unknown): BSV.DeviceState | null {
  if (typeof encoded !== 'string' || encoded === '' || encoded === '0') return null;
  try {
    return normalizeDeviceState(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
    );
  } catch {
    return null;
  }
}

/** JSON made safe for one Max symbol: no spaces, commas, semicolons or quotes. */
function encodeMaxAtom(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function decodeMaxAtom(value: unknown): unknown {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return JSON.parse(decodeURIComponent(value));
  } catch {
    return null;
  }
}

let deviceState: BSV.DeviceState | null = null;
let deviceStateEncoded = '';
let needsLegacyState = false;
let setInfoKnown = false;

interface DeviceStateWaiter {
  resolve: () => void;
  timer: NodeJS.Timeout;
}

const deviceStateWaiters = new Map<string, DeviceStateWaiter[]>();

function publishDeviceState(next: BSV.DeviceState): Promise<void> {
  const normalized = normalizeDeviceState(next) ?? { version: 1, roles: [] };
  deviceState = normalized;
  deviceStateEncoded = encodeDeviceState(normalized);
  const encoded = deviceStateEncoded;
  const confirmed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const waiting = deviceStateWaiters.get(encoded) ?? [];
      deviceStateWaiters.set(encoded, waiting.filter((w) => w.resolve !== resolve));
      reject(new Error('device did not confirm its stored state within 5 seconds'));
    }, 5000);
    const waiting = deviceStateWaiters.get(encoded) ?? [];
    waiting.push({ resolve, timer });
    deviceStateWaiters.set(encoded, waiting);
  });
  // Routed around lom.ts by the generated patcher into a Stored Only pattr.
  Max.outlet('device_state_set', encoded);
  broadcast({ type: 'deviceState', state: normalized });
  return confirmed;
}

/** Finish the one-time bsv.json/roles.json migration once set_info is known. */
function migrateLegacyDeviceState(): void {
  if (!needsLegacyState || !setInfoKnown) return;
  let roles: BSV.Role[] = [];
  const legacy = readLegacyVocabulary();
  if (legacy) {
    try {
      roles = cleanRoles((JSON.parse(legacy.toString()) as { roles?: unknown }).roles);
    } catch {
      Max.post('legacy role vocabulary is invalid — starting with no configured roles');
    }
  }
  needsLegacyState = false;
  // allowedColors is deliberately absent. The first connected UI migrates its
  // old localStorage value, where that browser-owned value can still be read.
  void publishDeviceState({ version: 1, roles })
    .then(() => Max.post(`device state: migrated ${roles.length} role(s) into the Live Set`))
    .catch((e) => Max.post(`device state migration failed — ${describe(e)}`));
}

interface Pending {
  /** Absent for a request the bridge made of itself — see `trackInternal`. */
  ws: WebSocket | undefined;
  type: BSV.RequestType;
  clientId?: number;
  started: number;
}

let lomReady = false;
let nextReqId = 1;
const pending = new Map<number, Pending>();

/**
 * The walk in flight, and everyone who asked for it after it started.
 *
 * `snapshot` had no coalescing at all, which was survivable while it took
 * someone pressing a button — and stopped being so when the app started
 * following Live. One structural change broadcasts `changed structure` to every
 * connected client, each of them answers by re-walking, and N walks serialize on
 * Live's main thread at ~950ms apiece.
 *
 * The first requester keeps its `pending` entry so progress and errors route the
 * way they always did; the rest ride along here. Each gets the payload stamped
 * with **its own** `clientId`, because that id is what resolves the waiter on
 * the other end.
 */
let snapshotFlight: { reqId: number; joined: Array<{ ws: WebSocket; clientId?: number }> } | null =
  null;

/**
 * Close out the flight `reqId` belongs to and hand back who was riding on it.
 *
 * **Every path that ends a walk must call this**, success or failure. A flight
 * left standing after a walk that errored would collect joiners forever and
 * never answer any of them — every later request would queue behind a walk that
 * is no longer running, which is a worse failure than the one that started it.
 */
function takeFlight(reqId: number): Array<{ ws: WebSocket; clientId?: number }> {
  if (snapshotFlight?.reqId !== reqId) return [];
  const { joined } = snapshotFlight;
  snapshotFlight = null;
  return joined;
}

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

/**
 * The built UI, inlined at bundle time as `path -> base64`.
 *
 * Substituted by esbuild (`define`), which is why it's a bare global rather than
 * an import: `npm run dev` compiles this file with plain tsc and no substitution
 * happens, so the `typeof` guard below leaves it empty and serving falls through
 * to `public/` on disk. That's the arrangement the dev loop wants anyway — vite
 * owns the UI there. See tools/build-bridge.ts.
 */
declare const BSV_ASSETS: Record<string, string> | undefined;
const ASSETS: Record<string, string> =
  typeof BSV_ASSETS === 'undefined' ? {} : BSV_ASSETS;

/** Serve an inlined asset, or 404 if this build has none. */
function serveEmbedded(rel: string, res: http.ServerResponse): void {
  const b64 = ASSETS[rel];
  if (b64 === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(rel)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(Buffer.from(b64, 'base64'));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';

  const file = path.join(PUBLIC, path.normalize(rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  // Disk first, embedded second. A `public/` folder beside the script wins so a
  // rebuilt UI can be dropped next to a shipped device without rebuilding it —
  // and so this stays the path it has always been when the folder is there.
  fs.readFile(file, (err, buf) => {
    if (err) {
      serveEmbedded(rel, res);
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

/**
 * Drive the device's Status line.
 *
 * It reads the number of connected clients, because that is the only part of
 * the device's state a glance at the rack can't already tell you — whether a
 * browser is attached at all, and whether you left three tabs open fighting
 * over the same set. "Connected to Live" was true from the moment the device
 * landed on a track, so it said nothing.
 *
 * `-1` is the one state that isn't a count: the LOM handshake hasn't completed.
 * That normally resolves within a frame of the server binding, so it stays on
 * screen only when something is actually wrong. The patcher turns the number
 * into words — see `tools/build-device.ts`.
 */
function showConnections(): void {
  let open = 0;
  // readyState rather than wss.clients.size: a socket mid-close still counts as
  // a client to `ws` for a moment, and a face that reads one connection with
  // nothing attached is worse than one that lags by a tick.
  for (const ws of wss.clients) if (ws.readyState === 1) open++;
  Max.outlet('status', lomReady ? open : -1);
}

wss.on('connection', (ws: WebSocket) => {
  Max.post(`client connected (${wss.clients.size} total)`);
  showConnections();
  send(ws, { type: 'status', lomReady });
  if (deviceState) send(ws, { type: 'deviceState', state: deviceState });

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

  ws.on('close', () => {
    // Before the log line: a client that closed the tab never sent `off`, and
    // its watches would otherwise be held open forever by a socket that is gone.
    releaseWatches(ws);
    Max.post(`client disconnected (${wss.clients.size} left)`);
    showConnections();
  });
});

function track(ws: WebSocket, m: BSV.Request): number {
  const reqId = nextReqId++;
  pending.set(reqId, { ws, type: m.type, clientId: m.id, started: Date.now() });
  return reqId;
}

// --- watch refcounting ------------------------------------------------
//
// Every watch is global in `lom.ts` — one observer list per kind, not one per
// client — so without this a client turning one off silently blinds every other
// client, and a client that vanishes never releases anything. Several UI dev
// servers already share one device, so this is exercised rather than
// hypothetical.
//
// **`on` is always forwarded; only `off` is edge-triggered**, and that asymmetry
// is deliberate rather than an oversight. `watch_play` and `watch_meters`
// install observers per *track* (and meters also on Master), so a client
// re-sends `on` to rebuild them when a snapshot reports a different track
// count — suppressing that because someone else already held the watch would
// leave the observers pointed at a set that no longer exists. Forwarding it
// costs nothing: every `watch_*` handler in `lom.ts` clears before it installs.
//
// Sets of sockets rather than integer counters, so a client sending `on` twice
// doesn't need two `off`s to release, and a dropped socket releases exactly what
// it was holding and nothing else.

const WATCH_MESSAGE = {
  observe: 'observe',
  selection: 'watch_selection',
  play: 'watch_play',
  meters: 'watch_meters',
  transport: 'watch_transport',
} as const;

type WatchKind = keyof typeof WATCH_MESSAGE;

const watchers: Record<WatchKind, Set<WebSocket>> = {
  observe: new Set(),
  selection: new Set(),
  play: new Set(),
  meters: new Set(),
  transport: new Set(),
};

function setWatch(ws: WebSocket, kind: WatchKind, on: boolean): void {
  const subs = watchers[kind];
  if (on) {
    subs.add(ws);
    Max.outlet(WATCH_MESSAGE[kind], 1);
    return;
  }
  // Nothing to release, or someone else still wants it.
  if (!subs.delete(ws) || subs.size > 0) return;
  Max.outlet(WATCH_MESSAGE[kind], 0);
}

/** A vanished client never sends `off`. Release whatever it was holding. */
function releaseWatches(ws: WebSocket): void {
  for (const kind of Object.keys(watchers) as WatchKind[]) setWatch(ws, kind, false);
}

/**
 * The LOM came back — the device reloaded, so its observer lists are empty
 * while our record of who wants what survived.
 *
 * Re-arm from that record instead of waiting for every client to notice on its
 * own. `useBridge` does re-send on `lomReady`, but a client that doesn't would
 * otherwise sit there believing it was still following Live.
 */
function rearmWatches(): void {
  for (const kind of Object.keys(watchers) as WatchKind[]) {
    if (watchers[kind].size > 0) Max.outlet(WATCH_MESSAGE[kind], 1);
  }
}

// --- Push song browser -------------------------------------------------
//
// Push's 8-encoder parameter strip shows any Live-visible parameter a
// selected device defines, via `live.banks` — see the pool of hidden
// parameters and the static bank definitions in `tools/build-device.ts`. The
// song list has to be held here rather than only derived in the browser
// (`useSongLayout`), because the point of the feature is jumping to a song
// with no browser tab open at all.

/** Two live.banks pages of eight positions each. Raise later; see the plan. */
const POOL_SIZE = 16;

/**
 * A starting budget for a bank-strip label, not a verified one. Cycling '74's
 * own generic `parameter_shortname` guidance is "5 to 7 characters" and isn't
 * Push-3-specific — calibrate against real hardware before trusting this.
 */
const PUSH_LABEL_MAX = 7;

interface PushSong {
  name: string;
  /** First scene carrying this song, ascending — what a jump lands on. */
  scene: number;
}

let heldScenes: BSV.Scene[] = [];
let heldRev = -1;
let pushSongs: PushSong[] = [];

/** Strip characters Max message syntax treats specially, then fit the budget. */
function sanitizePushLabel(name: string): string {
  const clean = name.replace(/[,;"]/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > PUSH_LABEL_MAX ? clean.slice(0, PUSH_LABEL_MAX) : clean;
}

/** Song `i` maps directly to bank position `i` — see `tools/build-device.ts`. */
function refreshPushBankStrip(): void {
  for (let i = 0; i < POOL_SIZE; i++) {
    const song = pushSongs[i];
    Max.outlet('push_shortname', i, song ? sanitizePushLabel(song.name) : '-');
  }
}

/** Re-derive the song list from whatever scene rows are currently held. */
function refreshPushSongs(scenes: readonly BSV.Scene[]): void {
  pushSongs = derive(scenes, SCENE_PATTERNS)
    .songs.map((s) => ({ name: s.name, scene: s.scenes[0] }))
    .sort((a, b) => a.scene - b.scene)
    .slice(0, POOL_SIZE);
  refreshPushBankStrip();
}

/** Move Live's own Session View selection — the same op `selectScene` uses. */
function selectSceneOnLive(scene: number): void {
  Max.outlet('select_scene', scene);
}

/** A snapshot request with no client behind it — see `requestInternalSnapshot`. */
function trackInternal(type: BSV.RequestType): number {
  const reqId = nextReqId++;
  pending.set(reqId, { ws: undefined, type, started: Date.now() });
  return reqId;
}

/**
 * Kick off a walk if nothing is already fetching one, so the Push song list
 * populates even when no browser tab has ever connected. Coalesces onto an
 * in-flight client-initiated walk the same way a second client's request
 * would — `snapshot_done` recomputes the song list regardless of who asked.
 */
function requestInternalSnapshot(): void {
  if (!lomReady || snapshotFlight) return;
  const reqId = trackInternal('snapshot');
  snapshotFlight = { reqId, joined: [] };
  Max.outlet('snapshot', reqId);
}

// Routed around lom.ts, same as device_state_get/set — see tools/build-device.ts.
Max.addHandler('push_pool', (i: number, value: number) => {
  if (!value) return; // the patch resets itself to 0 after outletting this
  const song = pushSongs[i];
  if (song) selectSceneOnLive(song.scene);
});

async function handle(ws: WebSocket, m: BSV.Request): Promise<void> {
  switch (m.type) {
    case 'snapshot': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      // A walk is already running. Wait for it instead of starting a second.
      if (snapshotFlight) {
        snapshotFlight.joined.push({ ws, clientId: m.id });
        return;
      }
      const reqId = track(ws, m);
      snapshotFlight = { reqId, joined: [] };
      Max.outlet('snapshot', reqId);
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
    // Additive scene creation gets its own route rather than borrowing the
    // reorder route, whose valid shape necessarily includes a delete pass.
    case 'addScenes': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      const addition = m.addition;
      const at = Number(addition?.at);
      const count = Number(addition?.count);
      const name = typeof addition?.name === 'string' ? addition.name.trim() : '';
      const color = addition?.color;
      const tempo = addition?.tempo;
      if (!Number.isInteger(at) || at < 0 || count !== 8) {
        return send(ws, {
          type: 'error',
          id: m.id,
          message: 'refusing malformed scene addition — expected eight scenes and a valid gap',
        });
      }
      if (!name) {
        return send(ws, { type: 'error', id: m.id, message: 'new scenes need a name' });
      }
      if (
        color !== undefined &&
        (!Number.isInteger(color) || color < 0 || color > 0xffffff)
      ) {
        return send(ws, { type: 'error', id: m.id, message: 'invalid scene color' });
      }
      if (
        tempo !== undefined &&
        (!Number.isFinite(tempo) || tempo < 20 || tempo > 1000)
      ) {
        return send(ws, { type: 'error', id: m.id, message: 'tempo must be 20–1000 BPM' });
      }
      const clean: BSV.SceneAddition = { at, count, name };
      if (color !== undefined) clean.color = color;
      if (tempo !== undefined) clean.tempo = tempo;
      const reqId = track(ws, m);
      try {
        await Max.setDict('bsv_ops', { addition: clean });
      } catch (e) {
        pending.delete(reqId);
        throw new Error(
          `could not stage ${count} new scenes into bsv_ops — ${describe(e)}. ` +
            `The dict must exist before Node can write it; lom.ts creates it on init.`,
        );
      }
      Max.outlet('add_scenes', reqId, 'bsv_ops');
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
    // Slots, not scenes — see `moveClips` in the protocol. Shares `bsv_ops` with
    // the two writes above for the same reason they share it: one staging dict,
    // and only one write can be in flight at a time anyway.
    case 'moveClips': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      const plan = m.plan;
      const steps = Array.isArray(plan?.steps) ? plan.steps : [];
      const remove = Array.isArray(plan?.remove) ? plan.remove : [];
      if (!steps.length) {
        return send(ws, { type: 'error', id: m.id, message: 'refusing an empty clip move' });
      }
      // A plan that clears more than it copies can only be one that deletes
      // clips it never moved. Caught here as well as in lom.ts, because the
      // failure mode is silent data loss rather than a visible error.
      if (remove.length > steps.length) {
        return send(ws, {
          type: 'error',
          id: m.id,
          message:
            `refusing a clip move that copies ${steps.length} and deletes ` +
            `${remove.length} — the plan is malformed`,
        });
      }
      const reqId = track(ws, m);
      try {
        await Max.setDict('bsv_ops', { clipPlan: { steps, remove } });
      } catch (e) {
        pending.delete(reqId);
        throw new Error(
          `could not stage a move of ${steps.length} clips into bsv_ops — ` +
            `${describe(e)}. The dict must exist before Node can write it; ` +
            `lom.ts creates it on init.`,
        );
      }
      Max.outlet('move_clips', reqId, 'bsv_ops');
      break;
    }
    case 'palette': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      Max.outlet('palette', track(ws, m));
      break;
    }
    // Developer diagnostics. Fire-and-forget like `observe`: no reqId, no
    // pending entry, no reply, because every answer lands in the Max window
    // instead. See the `diag` note in protocol/global.d.ts for why.
    case 'diag': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      Max.outlet('diag', String(m.what), Number(m.arg ?? 0));
      break;
    }
    // Device configuration is a Stored Only Max parameter. No LOM gate: it
    // belongs to this device instance and Live persists it with the .als.
    case 'saveRoles': {
      const roles = cleanRoles(m.roles);
      await publishDeviceState({
        ...(deviceState ?? { version: 1 as const, roles: [] }),
        roles,
      });
      Max.post(`device state: ${roles.length} role(s) saved`);
      send(ws, { type: 'rolesSaved', id: m.id, count: roles.length });
      break;
    }
    case 'saveAllowedColors': {
      const colors = cleanAllowedColors(m.colors);
      await publishDeviceState({
        ...(deviceState ?? { version: 1 as const, roles: [] }),
        allowedColors: colors,
      });
      send(ws, { type: 'allowedColorsSaved', id: m.id, colors });
      break;
    }
    case 'observe':
      setWatch(ws, 'observe', m.on);
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
    case 'setTransport': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      const source = m.patch;
      if (!source || typeof source !== 'object') {
        return send(ws, { type: 'error', id: m.id, message: 'transport patch is missing' });
      }
      const patch: BSV.TransportPatch = {};
      if (source.tempo !== undefined) {
        const tempo = Number(source.tempo);
        if (!Number.isFinite(tempo) || tempo < 20 || tempo > 999) {
          return send(ws, { type: 'error', id: m.id, message: 'tempo must be 20–999 BPM' });
        }
        patch.tempo = tempo;
      }
      if (source.metronome !== undefined) {
        if (typeof source.metronome !== 'boolean') {
          return send(ws, { type: 'error', id: m.id, message: 'metronome must be boolean' });
        }
        patch.metronome = source.metronome;
      }
      if (source.clipTriggerQuantization !== undefined) {
        const quantization = Number(source.clipTriggerQuantization);
        if (!Number.isInteger(quantization) || quantization < 0 || quantization > 13) {
          return send(ws, { type: 'error', id: m.id, message: 'invalid global quantization' });
        }
        patch.clipTriggerQuantization = quantization;
      }
      if (source.rootNote !== undefined) {
        const root = Number(source.rootNote);
        if (!Number.isInteger(root) || root < 0 || root > 11) {
          return send(ws, { type: 'error', id: m.id, message: 'root note must be 0–11' });
        }
        patch.rootNote = root;
      }
      if (source.scaleMode !== undefined) {
        if (typeof source.scaleMode !== 'boolean') {
          return send(ws, { type: 'error', id: m.id, message: 'scale mode must be boolean' });
        }
        patch.scaleMode = source.scaleMode;
      }
      if (source.scaleName !== undefined) {
        const name = String(source.scaleName).trim();
        if (!name || name.length > 100) {
          return send(ws, { type: 'error', id: m.id, message: 'invalid scale name' });
        }
        patch.scaleName = name;
      }
      if (Object.keys(patch).length === 0) {
        return send(ws, { type: 'error', id: m.id, message: 'transport patch is empty' });
      }
      // Fire-and-forget like playback. The observer pushes the value Live read
      // back, which is more useful than acknowledging that a set() was called.
      Max.outlet('set_transport', encodeMaxAtom(patch));
      break;
    }
    // Also fire-and-forget, and for the same reason as playback: the client
    // folded its own columns before sending. See `setFold` in the protocol.
    case 'setFold':
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      Max.outlet('set_fold', m.t, m.folded ? 1 : 0);
      break;
    // The Song Index has already scrolled its own grid. Tell Live to select
    // the same exact scene; Song.View centers the selected row in Session View.
    case 'selectScene': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      const scene = Number(m.s);
      if (!Number.isInteger(scene) || scene < 0) {
        return send(ws, { type: 'error', id: m.id, message: 'invalid scene index' });
      }
      selectSceneOnLive(scene);
      break;
    }
    case 'watchPlay':
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      setWatch(ws, 'play', m.on);
      break;
    case 'watchMeters':
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      setWatch(ws, 'meters', m.on);
      break;
    case 'watchTransport':
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      setWatch(ws, 'transport', m.on);
      break;
    case 'watchSelection':
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      setWatch(ws, 'selection', m.on);
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

// The generated patcher routes this around lom.ts. A base64url symbol is safe
// as one Max atom; JSON itself is not (spaces, commas and semicolons are Max
// message syntax). Asking explicitly on Node startup avoids depending on
// whether pattr restored before node.script had installed this handler.
Max.addHandler('device_state', (...atoms: unknown[]) => {
  const encoded = atoms.map(String).join('');
  const restored = decodeDeviceState(encoded);
  if (!restored) {
    needsLegacyState = true;
    migrateLegacyDeviceState();
    return;
  }
  needsLegacyState = false;
  const canonical = encodeDeviceState(restored);
  const waiting = deviceStateWaiters.get(canonical) ?? [];
  deviceStateWaiters.delete(canonical);
  // An older write may echo after a newer one was already emitted. Confirm the
  // old request without rolling the in-memory merge base back and losing a
  // field from the newer state.
  const superseded = waiting.length > 0 && canonical !== deviceStateEncoded;
  if (!superseded) {
    const changed = canonical !== deviceStateEncoded;
    deviceState = restored;
    deviceStateEncoded = canonical;
    if (changed) broadcast({ type: 'deviceState', state: restored });
  }
  for (const waiter of waiting) {
    clearTimeout(waiter.timer);
    waiter.resolve();
  }
  Max.post(
    `device state: restored ${restored.roles.length} role(s)` +
      (restored.allowedColors === undefined
        ? ' · awaiting allowed-color migration'
        : ` · ${restored.allowedColors === null ? 'all' : restored.allowedColors.length} allowed color(s)`),
  );
});

Max.addHandler('ready', () => {
  lomReady = true;
  Max.post('LOM ready');
  broadcast({ type: 'status', lomReady: true });
  showConnections(); // off the -1 holding state and onto a real count

  // A reloaded device has empty observer lists but our record of who wants what
  // survived, so put back whatever clients were already holding.
  rearmWatches();
  // Only needed when the pattr is empty and an old bsv.json may need importing.
  Max.outlet('set_info');
  // Populates the Push song list even if no browser tab ever connects.
  requestInternalSnapshot();
});

/**
 * Locate an old per-set bsv.json for one-time migration.
 *
 * `filePath` is the `.als`; the old vocabulary sits in its folder. This query
 * runs once when the LOM becomes ready and is irrelevant after a pattr restores.
 */
Max.addHandler('set_info_done', async (dictName: string) => {
  const info: { filePath?: string; name?: string } = await Max.getDict(dictName);
  const filePath = typeof info?.filePath === 'string' ? info.filePath : '';
  const dir = filePath ? path.dirname(filePath) : '';
  const name = typeof info?.name === 'string' ? info.name : '';
  setInfoKnown = true;
  if (dir === setDir && name === setName) {
    migrateLegacyDeviceState();
    return;
  }
  setDir = dir;
  setName = name;
  migrateLegacyDeviceState();
});

Max.addHandler('snapshot_done', async (reqId: number, dictName: string, dictMs: number) => {
  const req = pending.get(reqId);
  pending.delete(reqId);
  const flight = takeFlight(reqId);
  const t0 = Date.now();
  const data: BSV.Snapshot = await Max.getDict(dictName);
  const hostMs = Date.now() - t0;
  heldScenes = data.scenes;
  heldRev = data.rev;
  refreshPushSongs(heldScenes);
  const t = data.timings;
  Max.post(
    `snapshot: ${data.clipCount} clips in ${data.ms}ms lom ` +
      `(tracks ${t.tracks} · scenes ${t.scenes} · ${t.slotsScanned} slots ${t.slots} · clips ${t.clips}) ` +
      `+ ${dictMs}ms dict + ${hostMs}ms host`,
  );
  const event: BSV.Event = { type: 'snapshot', id: req?.clientId, dictMs, hostMs, data };
  // `req` is always set (`pending` always held an entry) except on a stray or
  // duplicate `snapshot_done`; a request this bridge made of itself (no `ws`,
  // see `requestInternalSnapshot`) has already gotten what it needed above and
  // broadcasting it again to every client would be a wasted duplicate.
  if (req?.ws) send(req.ws, event);
  else if (!req) broadcast(event);
  // Everyone who asked while this was running. Each needs the payload under its
  // own request id — that id is what resolves the waiter on the other end, so
  // one shared event object would answer exactly one of them.
  for (const j of flight) send(j.ws, { type: 'snapshot', id: j.clientId, dictMs, hostMs, data });
  if (flight.length > 0) {
    Max.post(`snapshot: one walk answered ${flight.length + 1} clients`);
  }
});

Max.addHandler('snapshot_progress', (reqId: number, done: number, total: number) => {
  const req = pending.get(reqId);
  send(req?.ws, { type: 'progress', id: req?.clientId, done, total });
  // Joiners are waiting on the same walk, so they get the same bar. Without
  // this they sit on a modal with no progress until the payload lands.
  if (snapshotFlight?.reqId === reqId) {
    for (const j of snapshotFlight.joined) {
      send(j.ws, { type: 'progress', id: j.clientId, done, total });
    }
  }
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

Max.addHandler('add_scenes_done', async (reqId: number, dictName: string, ms: number) => {
  const req = pending.get(reqId);
  pending.delete(reqId);
  const r: BSV.ScenesAddedResult = await Max.getDict(dictName);
  Max.post(
    `addScenes: ${r.created} created, ${r.configured} configured, ` +
      `${r.failed} failed, ${ms}ms` +
      (r.undoStep ? ' (one undo step)' : ' (NOT grouped in Live undo)'),
  );
  send(req?.ws, { type: 'scenesAdded', id: req?.clientId, lomMs: ms, ...r });
  // Every scene index at or below the insertion point changed. Other clients
  // must discard their snapshots before another click can address the old row.
  broadcast({ type: 'changed', kind: 'structure' });
  requestInternalSnapshot();
});

Max.addHandler('move_progress', (reqId: number, done: number, total: number) => {
  const req = pending.get(reqId);
  send(req?.ws, { type: 'progress', id: req?.clientId, done, total });
});

Max.addHandler('move_clips_done', async (reqId: number, dictName: string, ms: number) => {
  const req = pending.get(reqId);
  pending.delete(reqId);
  const r: { copied: number; removed: number; failed: number; undoStep: boolean } =
    await Max.getDict(dictName);
  Max.post(
    `moveClips: ${r.copied} copied, ${r.removed} deleted, ${r.failed} failed, ${ms}ms` +
      (r.undoStep ? ' (one undo step)' : ' (NOT undoable in Live)'),
  );
  send(req?.ws, { type: 'clipsMoved', id: req?.clientId, lomMs: ms, ...r });
  // Not structural the way a scene move is — every index still means what it
  // meant — but the grid's contents moved, so other clients are showing clips
  // where there aren't any.
  broadcast({ type: 'changed', kind: 'clipsMoved' });
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
  // Structural, so every client's scene indexes just became wrong. This is the
  // one change where a stale grid is actively dangerous rather than merely out
  // of date — a click lands on a different scene than it looks like.
  //
  // `structure`, not `moved`: the client re-walks on `structure` and only logs
  // `moved`, so the old kind announced the danger to a handler that did nothing
  // about it. What actually recovered other clients was the observer burst
  // during the move — which had them walking a set that was halfway rearranged.
  // That burst is muted in `lom.ts` now, and this is the one event in its place.
  broadcast({ type: 'changed', kind: 'structure' });
  requestInternalSnapshot();
});

Max.addHandler('palette_done', async (reqId: number, dictName: string) => {
  const req = pending.get(reqId);
  pending.delete(reqId);
  const p: BSV.Palette = await Max.getDict(dictName);
  Max.post(`palette diagnostic: ${p.count} colors extracted (not persisted)`);
  send(req?.ws, { type: 'palette', id: req?.clientId, ...p });
});

Max.addHandler('changed', (kind: string) => broadcast({ type: 'changed', kind }));

// A partial re-read, pushed because the user changed something in Live rather
// than because anyone asked. Broadcast: every client holds the same set, and a
// delta is far cheaper than each of them walking it. Unlike the realtime pushes
// below this carries clip names, so it travels by Dict — names contain spaces,
// commas and semicolons, all special in Max messages.
Max.addHandler('delta', async (dictName: string) => {
  try {
    const data: BSV.SnapshotDelta = await Max.getDict(dictName);
    Max.post(
      `delta: ${data.clips.length} clip(s) across track(s) ` +
        `${data.clipScope.join(', ')} in ${data.ms}ms (rev ${data.prevRev} -> ${data.rev})`,
    );
    // A rename is exactly this: `apply` broadcasts `changed: 'applied'`, not
    // `'structure'`, so this delta is the only signal that scene names — and
    // therefore the Push song list — may have changed. `rev` advances on
    // every delta regardless of what it touched, so it's tracked whenever the
    // check passes, not only on the deltas with scene rows to merge — else a
    // clip-only delta between two scene-bearing ones would permanently strand
    // `heldRev` one revision behind. A mismatch means a message was missed;
    // the next full snapshot (`requestInternalSnapshot`'s triggers) recovers
    // rather than merging against the wrong revision.
    if (canApplyDelta(heldRev, data.prevRev)) {
      heldRev = data.rev;
      if (data.sceneRows) {
        heldScenes = mergeRows(heldScenes, data.sceneRows);
        refreshPushSongs(heldScenes);
      }
    }
    broadcast({ type: 'delta', data });
  } catch (e) {
    // A delta that can't be read is not worth failing a client over — the
    // client re-walks whenever a rev doesn't line up, so the worst case here
    // is one skipped update rather than a wrong grid.
    Max.post(`delta: could not read ${dictName} — ${describe(e)}`);
  }
});

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

// One coherent frame: master first, then track/level pairs. lom.ts updates the
// values from independent observers and sends every latest value together.
Max.addHandler('meter_levels', (...args: number[]) => {
  const master = Number(args[0]);
  if (!Number.isFinite(master)) return;
  const tracks: BSV.TrackMeterLevel[] = [];
  for (let i = 1; i + 1 < args.length; i += 2) {
    const t = Number(args[i]);
    const level = Number(args[i + 1]);
    if (!Number.isFinite(t) || !Number.isFinite(level)) continue;
    tracks.push({ t, level });
  }
  broadcast({ type: 'meterLevels', frame: { master, tracks } });
});

// Kept separate from play_state: current_song_time changes continuously, and
// making each tick re-read every track would turn one cheap clock into dozens
// of LOM calls. lom.ts already reduces this stream to displayed sixteenths.
Max.addHandler(
  'song_position',
  (bar: number, beat: number, sixteenth: number) => {
    broadcast({
      type: 'songPosition',
      bar: Number(bar),
      beat: Number(beat),
      sixteenth: Number(sixteenth),
    });
  },
);

Max.addHandler('transport_state', (...atoms: unknown[]) => {
  const value = decodeMaxAtom(atoms.map(String).join(''));
  if (!value || typeof value !== 'object') {
    Max.post('transport_state: malformed payload from lom');
    return;
  }
  const state = value as Partial<BSV.TransportState>;
  if (
    !Number.isFinite(state.tempo) || state.tempo! < 20 || state.tempo! > 999 ||
    typeof state.metronome !== 'boolean' ||
    !Number.isInteger(state.clipTriggerQuantization) ||
    state.clipTriggerQuantization! < 0 || state.clipTriggerQuantization! > 13 ||
    !Number.isInteger(state.rootNote) || state.rootNote! < 0 || state.rootNote! > 11 ||
    typeof state.scaleName !== 'string' ||
    typeof state.scaleMode !== 'boolean'
  ) {
    Max.post('transport_state: invalid fields from lom');
    return;
  }
  broadcast({ type: 'transportState', state: state as BSV.TransportState });
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
  // With no id, no waiter is rejected; the client just logs it. A request the
  // bridge made of itself (no `ws`) has no one to tell either, but it isn't
  // untracked, so it must not fall into the broadcast meant for that case.
  if (req?.ws) send(req.ws, event);
  else if (!req) broadcast(event);
  // A failed walk has to fail for everyone riding on it too, or they wait out
  // their request timeout on a walk that is already over — and the flight would
  // never clear, stranding every request after it as well.
  for (const j of takeFlight(reqId)) send(j.ws, { type: 'error', id: j.clientId, message });
});

Max.addHandler('pong', () => {});

// --- dev: live reload -------------------------------------------------
// Vite's own HMR covers the dev server. This covers the built output being
// served straight out of public/.

// A shipped device has no public/ at all — its UI is inlined and cannot change
// underneath it. That's the normal state, not a degraded one, so it gets no
// warning; a missing folder is only worth reporting when someone meant it to be
// there, which is exactly the case where it exists and the watch itself fails.
let reloadTimer: NodeJS.Timeout | undefined;
if (fs.existsSync(PUBLIC)) {
  try {
    fs.watch(PUBLIC, { recursive: true }, () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        Max.post('public/ changed — reloading clients');
        broadcast({ type: 'reload' });
      }, 120); // editors emit several events per save
    });
  } catch (e) {
    Max.post(`could not watch public/ — live reload off (${describe(e)})`);
  }
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
  showConnections(); // drives the device's Status line; routed off before lom
  Max.outlet('device_state_get'); // restored pattr -> device_state handler above
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
