// bridge.ts — compiled to bridge/bridge.js and run by Node for Max.
//
// Owns the WebSocket server. Knows nothing about the Live Object Model; it just
// relays coarse-grained requests to lom.ts and streams results back.
//
// It used to serve the session manager too, with the built app inlined as base64
// — 595 kB of web app parsed inside Live's process on every device load. The
// front ends are desktop apps now and this bridges Live and nothing else, which
// is the one job that has to happen inside Max.
//
// Protocol types come from the global OpenFlow namespace rather than an import, so
// this can emit to a flat file outside its own rootDir.

import Max = require('max-api');
import http = require('node:http');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { WebSocketServer, WebSocket } from 'ws';
import { MIN_INTERVAL_MS, STALE_MS, shouldWalk } from '@openflow/core/backstop.ts';
import { applyClipMove } from '@openflow/core/clipMove.ts';
import { derive } from '@openflow/core/derive.ts';
import { LIVE_PALETTE } from '@openflow/core/livePalette.ts';
import { SCENE_PATTERNS } from '@openflow/core/namePattern.ts';
import { applyOps } from '@openflow/core/ops.ts';
import { applySceneOps } from '@openflow/core/roles.ts';
import { buildSetModel } from '@openflow/core/setModel.ts';
import {
  mergeChainWatches,
  sameChainWatches,
  validChainWatch,
  type ChainWatch,
} from '@openflow/core/chainWatch.ts';
import { canApplyDelta, mergeRows, mergeTrackDelta } from '@openflow/core/snapshotDelta.ts';

const PORT = Number(process.env.OPENFLOW_PORT) || 17800;
/**
 * Most clips one `clipNotes` may ask about.
 *
 * A scene's worth of playing clips is a dozen at the outside; this is the
 * bound that stops a malformed ask turning into Live opening hundreds of clips
 * inside one Max message.
 */
const CLIP_NOTES_MAX = 32;
const HOST = '127.0.0.1';
const WS_PATH = '/ws';

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
  const override = process.env.OPENFLOW_STATE_DIR;
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
function cleanRoles(value: unknown): OpenFlow.Role[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (r): r is OpenFlow.Role =>
      !!r && typeof r === 'object' &&
      typeof (r as OpenFlow.Role).name === 'string' &&
      (r as OpenFlow.Role).name.trim() !== '' &&
      Number.isInteger((r as OpenFlow.Role).colorIndex) &&
      (r as OpenFlow.Role).colorIndex >= -1,
  ).map((r) => ({ name: r.name.trim(), colorIndex: r.colorIndex }));
}

function cleanAllowedColors(value: unknown): number[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value.filter((v): v is number => Number.isInteger(v) && v >= 0),
  )].sort((a, b) => a - b);
}

function cleanDefaultArtist(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDeviceState(value: unknown): OpenFlow.DeviceState | null {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) {
    return null;
  }
  const source = value as {
    defaultArtist?: unknown;
    roles?: unknown;
    allowedColors?: unknown;
    writeSceneTempo?: unknown;
  };
  const state: OpenFlow.DeviceState = {
    version: 1,
    defaultArtist: cleanDefaultArtist(source.defaultArtist),
    roles: cleanRoles(source.roles),
  };
  if (Object.prototype.hasOwnProperty.call(source, 'allowedColors')) {
    state.allowedColors = cleanAllowedColors(source.allowedColors);
  }
  // Only when it's on. Absent already means off, so writing `false` would grow
  // the stored blob for nothing — and this is a Max symbol with a size limit.
  if (source.writeSceneTempo === true) state.writeSceneTempo = true;
  return state;
}

function encodeDeviceState(state: OpenFlow.DeviceState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

function decodeDeviceState(encoded: unknown): OpenFlow.DeviceState | null {
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

let deviceState: OpenFlow.DeviceState | null = null;
let deviceStateEncoded = '';
let needsLegacyState = false;
let setInfoKnown = false;

interface DeviceStateWaiter {
  resolve: () => void;
  timer: NodeJS.Timeout;
}

const deviceStateWaiters = new Map<string, DeviceStateWaiter[]>();

function publishDeviceState(next: OpenFlow.DeviceState): Promise<void> {
  const normalized = normalizeDeviceState(next) ?? {
    version: 1,
    defaultArtist: '',
    roles: [],
  };
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
  let roles: OpenFlow.Role[] = [];
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
  void publishDeviceState({ version: 1, defaultArtist: '', roles })
    .then(() => Max.post(`device state: migrated ${roles.length} role(s) into the Live Set`))
    .catch((e) => Max.post(`device state migration failed — ${describe(e)}`));
}

/**
 * What a write will do to the set if Live takes all of it.
 *
 * Kept on the pending entry because the answer from `lom.ts` is a set of
 * *counts* — it never says which ops it skipped — so the only way to patch the
 * held snapshot is to have the request that produced them still in hand. This
 * is the same batch or plan the client patches its own copy with; see
 * `set/docs/snapshot-lifecycle.md` under *A write patches the snapshot*.
 */
type Written =
  | { kind: 'apply'; ops: OpenFlow.ApplyOp[]; sceneOps: OpenFlow.SceneOp[] }
  | { kind: 'clips'; plan: OpenFlow.ClipMovePlan };

interface Pending {
  /** Absent for a request the bridge made of itself — see `trackInternal`. */
  ws: WebSocket | undefined;
  type: OpenFlow.RequestType;
  clientId?: number;
  started: number;
  written?: Written;
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
let snapshotFlight: {
  reqId: number;
  joined: Array<{ ws: WebSocket; clientId?: number }>;
  /** `heldGeneration` when the walk started — see `startFlight`. */
  generation: number;
} | null = null;

/**
 * Begin a walk, remembering which set it is a walk *of*.
 *
 * The generation is the whole reason this isn't an inline assignment: a walk
 * that started before an invalidation describes a set that no longer exists,
 * and it must not become the held copy when it lands. See `heldGeneration`.
 */
function startFlight(reqId: number): void {
  snapshotFlight = { reqId, joined: [], generation: heldGeneration };
  if (flightTimer) clearTimeout(flightTimer);
  flightTimer = setTimeout(() => failFlight(reqId, 'the walk never answered'), FLIGHT_TIMEOUT_MS);
  flightTimer.unref?.();
  Max.outlet('snapshot', reqId);
}

/**
 * How long a walk may be in flight before it is presumed lost.
 *
 * Far past any real walk — a full one is ~2.6s and a chunked one over a huge set
 * has been seen at ten. It exists because a flight is cleared only by a matching
 * `snapshot_done` or `err`: a reply that never arrives strands every later
 * snapshot on a walk that is not running, and `ready` re-arms everything except
 * this, so reloading the LOM does not recover it either.
 */
const FLIGHT_TIMEOUT_MS = 45_000;
let flightTimer: NodeJS.Timeout | null = null;

/** End a flight nothing answered, failing everyone on it the way `err` does. */
function failFlight(reqId: number, why: string): void {
  if (snapshotFlight?.reqId !== reqId) return;
  const req = pending.get(reqId);
  pending.delete(reqId);
  const message = `snapshot: ${why}`;
  Max.post(message);
  if (req?.ws) send(req.ws, { type: 'error', id: req.clientId, message });
  for (const j of takeFlight(reqId)) send(j.ws, { type: 'error', id: j.clientId, message });
}

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
  if (flightTimer) {
    clearTimeout(flightTimer);
    flightTimer = null;
  }
  return joined;
}

// --- the server ---------------------------------------------------------

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
 * There is a server here because a WebSocket needs one, and for nothing else.
 *
 * It used to serve the session manager, which is why `bridge.js` carried 595 kB
 * of base64 web app into Live's process. That app is a window of its own now —
 * see `set/docs/desktop.md` — so what is left is the four lines it takes to
 * answer somebody who typed the address into a browser out of habit, and the
 * `http.Server` that `ws` attaches to.
 *
 * Kept as an `http.Server` rather than letting `ws` make its own, because
 * `server.listen`'s callback is this process's whole startup handshake and both
 * of the error listeners at the bottom of this file are load-bearing.
 */
const server = http.createServer((req, res) => {
  res.writeHead(req.url === '/' ? 200 : 404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('open[flow] bridge. The WebSocket is at /ws; the session manager is a desktop app.\n');
});

const wss = new WebSocketServer({ server, path: WS_PATH });

/**
 * Most bytes allowed to queue on one socket before it is treated as gone.
 *
 * `readyState` says a socket is open; it does not say anything is reading it. A
 * client that stopped draining still takes meter frames at 30 Hz, and they
 * accumulate inside Live's Node process — on the order of a hundred megabytes an
 * hour for a browser nobody is looking at. Dropping it costs a reconnect, which
 * this protocol does by itself.
 */
const MAX_BUFFERED = 4 * 1024 * 1024;

function writable(ws: WebSocket): boolean {
  if (ws.readyState !== 1) return false;
  if (ws.bufferedAmount <= MAX_BUFFERED) return true;
  Max.post(`client is not reading — ${ws.bufferedAmount} bytes queued, dropping it`);
  ws.terminate();
  return false;
}

function send(ws: WebSocket | undefined, event: OpenFlow.Event): void {
  if (ws && writable(ws)) ws.send(JSON.stringify(event));
}

function broadcast(event: OpenFlow.Event): void {
  const s = JSON.stringify(event);
  for (const ws of wss.clients) if (writable(ws)) ws.send(s);
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
  alive.add(ws);
  showConnections();
  send(ws, { type: 'status', lomReady });
  if (deviceState) send(ws, { type: 'deviceState', state: deviceState });

  // `ws` throws on a socket whose 'error' nobody listens for, so an unclean
  // disconnect — a phone off the LAN, a force-killed browser — would take the
  // whole device with it. The 'close' that follows does the cleanup.
  ws.on('error', (e) => {
    Max.post(`client socket error — ${describe(e)}`);
  });

  ws.on('pong', () => alive.add(ws));

  ws.on('message', async (raw) => {
    let m: OpenFlow.Request;
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

/**
 * A client that answered the last sweep. A protocol-level ping, not the app's.
 *
 * The app's `ping` is client-initiated, so nothing here ever asks a silent
 * socket whether it is still there. A laptop that slept or a phone that walked
 * off the LAN leaves a half-open socket that `readyState` calls OPEN forever,
 * and its watch refcounts keep up to four hundred LOM observers armed for a
 * browser that is gone.
 */
const alive = new WeakSet<WebSocket>();
const HEARTBEAT_MS = 15_000;

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    if (!alive.has(ws)) {
      Max.post('client stopped answering — dropping it');
      ws.terminate();
      continue;
    }
    alive.delete(ws);
    ws.ping();
  }
}, HEARTBEAT_MS);
heartbeat.unref?.();

function track(ws: WebSocket, m: OpenFlow.Request, written?: Written): number {
  const reqId = nextReqId++;
  pending.set(reqId, { ws, type: m.type, clientId: m.id, started: Date.now(), written });
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
// is deliberate rather than an oversight. `watch_play`, `watch_meters` and
// `watch_sends` install observers per *track* (and meters also on Master), so a
// client
// re-sends `on` to rebuild them when a snapshot reports a different track
// count — suppressing that because someone else already held the watch would
// leave the observers pointed at a set that no longer exists. Forwarding it
// costs nothing: every `watch_*` handler in `lom.ts` clears or rebuilds before
// it installs.
//
// Sets of sockets rather than integer counters, so a client sending `on` twice
// doesn't need two `off`s to release, and a dropped socket releases exactly what
// it was holding and nothing else.

const WATCH_MESSAGE = {
  observe: 'observe',
  selection: 'watch_selection',
  play: 'watch_play',
  meters: 'watch_meters',
  status: 'watch_status',
  sends: 'watch_sends',
  transport: 'watch_transport',
} as const;

type WatchKind = keyof typeof WATCH_MESSAGE;

const watchers: Record<WatchKind, Set<WebSocket>> = {
  observe: new Set(),
  selection: new Set(),
  play: new Set(),
  meters: new Set(),
  status: new Set(),
  sends: new Set(),
  transport: new Set(),
};

/**
 * Watches the **device** owns, for its own sake, from the moment the LOM is
 * ready until it goes away. Never refcounted, never released.
 *
 * These two are not features a browser subscribes to — they are how the bridge
 * keeps the set it holds current. `observe` says the set restructured;
 * `watch_selection` is how a clip edited in Live reaches the held copy. Without
 * them running, the thing this process exists to maintain goes stale, whether
 * or not anyone is looking at it.
 *
 * Refcounting them against sockets was the mistake underneath a string of
 * symptoms. Every connect re-installed the LOM observers, and installing a
 * LiveAPI property observer makes Live call back once with the value it already
 * had — which arrives as `changed structure` and drops the held set. So opening
 * the page invalidated the cache the page was about to read, and closing the
 * last tab tore down the observers entirely, leaving the bridge blind until
 * someone connected again. **A client connecting or disconnecting must not
 * change what the device knows.**
 */
const DEVICE_WATCHES = ['observe', 'selection'] as const;

function isDeviceWatch(kind: WatchKind): boolean {
  return (DEVICE_WATCHES as readonly string[]).includes(kind);
}

/**
 * Client-owned watches are re-armed on every subscribe deliberately: they answer
 * with a frame, and a client joining an already-watched stream would otherwise
 * wait for the next change before it had any state at all. They also install
 * observers per *track*, so a client re-sends `on` to rebuild them when a
 * snapshot finds a different track count.
 */
function setWatch(ws: WebSocket, kind: WatchKind, on: boolean): void {
  // A client can neither claim nor release these; they are already running.
  if (isDeviceWatch(kind)) return;
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

/**
 * Start the watches the device owns. Called once per LOM lifetime.
 *
 * `observe` echoes on install — see `expectStructureEcho` — and because this is
 * now the only path that arms it, that echo happens once per device start
 * rather than once per browser connect.
 */
function armDeviceWatches(): void {
  expectStructureEcho();
  for (const kind of DEVICE_WATCHES) Max.outlet(WATCH_MESSAGE[kind], 1);
  Max.post('watching Live for the device: structural changes and the Session cursor');
}

// --- targeted watches --------------------------------------------------
//
// A watch whose cost depends on *what* is being watched, not merely on whether
// anyone is. The set above cannot express one: `watchers.play` is a set of
// sockets because arming `watch_play` costs the same whoever asked, and a
// device chain's does not — a run of shells is a couple of observers per
// device, one open EQ Eight is forty more, and two clients can be looking at
// different racks with neither allowed to release the other's.
//
// So a client declares its **whole current view** rather than toggling. There
// is no `off`: an empty array is how you stop, a dropped socket is exactly
// equivalent to sending one, and no message a client can send releases a
// subscription another client is holding. The union is `core/src/chainWatch.ts`,
// where it has tests.
//
// One kind today. The map and the recompute are deliberately not specialised to
// it — the next per-target watch (a clip's notes, one track's routing) is the
// same shape, and the thing worth reusing is this bookkeeping rather than the
// merge, which is per-kind by nature.

const chainWatchers = new Map<WebSocket, OpenFlow.ChainWatch[]>();

/** The union last sent to `lom.ts`, so an unchanged one is never re-sent. */
let chainUnion: ChainWatch[] = [];

/**
 * Recompute the union and tell the LOM side, if it changed.
 *
 * **Skipping the unchanged case is not an optimisation.** `watch_chains`
 * rebuilds every observer it holds each time it is told, the way `watch_play`
 * does — so re-sending an identical union tears down and reinstalls the lot,
 * and a client that re-declares on every render would do that continuously.
 */
function pushChainWatches(force = false): void {
  const next = mergeChainWatches([...chainWatchers.values()]);
  if (!force && sameChainWatches(next, chainUnion)) return;
  chainUnion = next;
  Max.outlet('watch_chains', encodeMaxAtom(next));
}

/**
 * Replace one client's declaration. Returns an error string, or null.
 *
 * A malformed entry rejects the whole message rather than being filtered out of
 * it. A subscription list silently shortened is a client drawing knobs that
 * will never move, which looks like a bridge bug from every angle except this
 * one — the same bargain `chainDevice` makes on the way in.
 */
function setChainWatch(ws: WebSocket, subs: unknown): string | null {
  if (!Array.isArray(subs)) return 'watchChains needs a list of subscriptions';
  for (const sub of subs) {
    if (!validChainWatch(sub)) return 'watchChains got a malformed subscription';
  }
  if (subs.length === 0) chainWatchers.delete(ws);
  else chainWatchers.set(ws, subs as OpenFlow.ChainWatch[]);
  pushChainWatches();
  return null;
}

/** A vanished client never sends `off`. Release whatever it was holding. */
function releaseWatches(ws: WebSocket): void {
  for (const kind of Object.keys(watchers) as WatchKind[]) setWatch(ws, kind, false);
  if (chainWatchers.delete(ws)) pushChainWatches();
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
  // `force`, because the union is unchanged — it is the observers behind it
  // that are gone. The skip-if-unchanged guard is exactly wrong here.
  if (chainWatchers.size > 0) pushChainWatches(true);
}

// --- the set we hold ---------------------------------------------------
//
// The bridge keeps the last snapshot and the model read from it, and keeps both
// current from the same signals every client already gets: deltas from Live, and
// the writes we send there ourselves. A client asking for the set is then a
// payload rather than a walk of every clip slot in it — which is the difference
// between a second tab that opens instantly and one that waits out ~8.8s on a
// full-size set. See `bridge/docs/multiple-clients.md`.
//
// **Held state is dropped on any doubt at all.** A snapshot that has silently
// drifted from Live is far worse than a walk: the grid disagrees with Live with
// no hint which of the two is lying, and nothing ever says so. A walk is slow
// and visible, so every uncertain case takes it.

interface HeldSet {
  snapshot: OpenFlow.Snapshot;
  /** Read from `snapshot`. See `core/docs/setModel.md`. */
  model: OpenFlow.SetModel;
  /**
   * The two host-side costs of the walk this was first read by.
   *
   * Kept and re-sent rather than zeroed on a cached answer: `Snapshot.ms` and
   * `timings` inside the payload describe that same walk and can't honestly be
   * rewritten, so zeroing only these two would make one answer disagree with
   * itself. `cached: true` is what says the numbers are a walk that already
   * happened — see `protocol/README.md` on timing fields.
   */
  dictMs: number;
  hostMs: number;
}

let held: HeldSet | null = null;

/**
 * Bumped by every invalidation, and recorded by a walk when it starts.
 *
 * **A walk that began before an invalidation must not become the held set**,
 * even though it finishes after one. `snapshot()` in `lom.ts` runs inside one
 * Max message but a scene move is a chunked `Task`, so a walk can land between
 * two chunks and read a set that is halfway rearranged. Dropping on `move_done`
 * doesn't cover that: the drop happens first and the stale payload arrives
 * after it, with nothing left to say it was stale. This counter is what says so.
 */
let heldGeneration = 0;

/**
 * Forget the set we hold, because something happened that we cannot patch.
 *
 * Deliberately does **not** start a walk of its own — the *callers* decide that,
 * and they don't agree, on purpose. A structural change means the set is a
 * different shape and the bridge's job is to know it, so those callers go and
 * look. A write Live took only partly leaves us unsure rather than behind, and
 * the client that made it is already re-walking; a second walk from here would
 * be the same read twice.
 *
 * Live's main thread is the scarce resource in all of this. Until whatever walk
 * is coming lands, Push keeps the song list it already has rather than going
 * blank.
 */
function dropHeld(why: string): void {
  // Before the `held` check, not after: with nothing held and a walk in flight,
  // the bump is the entire point of the call.
  heldGeneration++;
  const inFlight = held === null && snapshotFlight !== null;
  held = null;
  // Logged even with nothing held, which it did not used to be. That silence
  // hid this exact bug for a release: a drop landing on an empty `held` during
  // the device's own first walk still discards that walk through the
  // generation, and the only visible trace was a walk that ran twice.
  Max.post(
    `held set dropped — ${why}.` +
      (inFlight
        ? ' A walk is running and will be answered but not held.'
        : ' The next snapshot request walks Live.'),
  );
}

/**
 * How long a `changed structure` may still be the echo of arming `observe`.
 *
 * Generous because the echo queues behind whatever Live is doing, and on a
 * device that has just started that is a full walk of the set — seconds, not
 * milliseconds. The window costs nothing when it is wrong in the quiet
 * direction (no echo arrives, it lapses) and the counter is what stops it being
 * wrong in the loud one.
 */
const STRUCTURE_ECHO_MS = 10_000;

/**
 * One structural change is expected, and is not a structural change.
 *
 * Installing a LiveAPI property observer makes Live call back immediately with
 * the current value, so arming `observe` always produces one `changed
 * structure` per observer that means nothing happened. Swallowing it is what
 * keeps a browser connecting — or a device starting — from throwing away the
 * held set and re-walking every clip slot to learn what it already knew.
 *
 * **Counted and time-boxed, because the alternative failure is worse.** A count
 * alone would silently eat the next real structural change if Live ever stopped
 * echoing; a window alone would eat every structural edit made in the first ten
 * seconds. Together, at most `STRUCTURE_ECHO_MS` of grace for at most the
 * number of observers being installed, and a set genuinely restructured in that
 * window is still caught by the client's own re-walk on `changed`.
 */
const STRUCTURE_OBSERVERS = 2;
/**
 * Ceiling on outstanding echoes, in case something arms in a loop. Four arms is
 * already more than any real sequence — a browser reload under StrictMode is
 * two — and past that the window lapsing is the safer failure.
 */
const STRUCTURE_ECHO_MAX = STRUCTURE_OBSERVERS * 4;
let structureEchoesDue = 0;
let structureEchoTimer: NodeJS.Timeout | null = null;

function expectStructureEcho(): void {
  // **Accumulates rather than resets**, and that is not a detail. React
  // StrictMode mounts, unmounts and mounts again, so one page load in dev arms
  // this twice before the first pair of echoes has even been delivered — they
  // queue behind whatever Live is doing. Resetting to two meant four echoes
  // arrived, two were swallowed and two dropped the held set, which is the
  // whole bug over again with a smaller window.
  structureEchoesDue = Math.min(structureEchoesDue + STRUCTURE_OBSERVERS, STRUCTURE_ECHO_MAX);
  if (structureEchoTimer) clearTimeout(structureEchoTimer);
  structureEchoTimer = setTimeout(() => {
    structureEchoTimer = null;
    structureEchoesDue = 0;
  }, STRUCTURE_ECHO_MS);
  // `unref` so a pending window can never hold the Node for Max process open.
  structureEchoTimer.unref?.();
}

/** True when this `changed structure` is the echo of arming the observers. */
function takeStructureEcho(): boolean {
  if (structureEchoesDue <= 0) return false;
  structureEchoesDue--;
  return true;
}

/**
 * Re-read the mapping from scene rows we have just patched, and re-label Push.
 *
 * For the two paths that change the held set in place. A *walk* does the same
 * two steps separately, because it may turn out not to be holdable at all and
 * the encoder must not be relabelled from a set that no longer exists.
 */
function rereadModel(rev: number, scenes: readonly OpenFlow.Scene[]): OpenFlow.SetModel {
  const model = buildSetModel(derive(scenes, SCENE_PATTERNS), rev);
  refreshPushSongs(model);
  return model;
}

// --- Push song browser -------------------------------------------------
//
// One Enum parameter on Push's encoder strip — see `tools/build-device.ts` for
// the parameter, its live.banks page, and what Cycling '74 documents about
// naming an Enum's values at runtime. Its value is a position in the running
// order and its value labels are the songs, so turning the encoder walks the
// set with the name under your hand. It selects that song's first scene in
// Live and fires nothing, so scrubbing mid-song is safe.
//
// The song list is held here rather than only derived in the browser
// (`useSongLayout`), because the point of the feature is jumping to a song
// with no browser tab open at all.
//
// **The names are on the display.** Live does re-read an Enum's item list after
// the device has loaded, so a runtime `_parameter_range` reaches Push. Push
// itself does not re-read: it keeps whatever it held when the bank page
// appeared, which is why every write here is followed by a redefinition of that
// page. What is still unmeasured is narrower — where Push truncates a long
// name, and whether the non-breaking space below is doing anything at all.
// `diag labels` / `diag labelspaces` / `diag bank` measure those one at a time,
// with no song list in the frame.

/**
 * Cycling '74's guidance for a `parameter_shortname` is "5 to 7 characters",
 * and it isn't Push-3-specific. Kept a little over that to find out where Push
 * actually truncates rather than assuming the generic number — a name cut short
 * by the hardware still reads, where one cut short here is gone for good.
 */
const PUSH_LABEL_MAX = 12;

/**
 * Positions on the encoder, and the number of placeholders the parameter is
 * declared with in `tools/build-device.ts`. The two must agree.
 *
 * **Fixed, and deliberately larger than any set.** Sizing the parameter to the
 * running order is the obvious design and it is the one that failed: on
 * hardware `_parameter_range` propagated while `_parameter_steps` did not,
 * leaving a 34-song set spanning 0…33 in two detents. Push also caches what it
 * was told about a control, so a parameter that changes shape underneath it
 * goes wrong in a way that outlives the write. Only the *text* moves at
 * runtime; the span and the detent count are baked in and never touched.
 *
 * The cost is a tail of empty positions past the end of the set, which costs
 * nothing because nobody turns into it. The cap exists only so a pathological
 * set can't ask Live for a parameter with thousands of detents.
 */
const PUSH_SONG_MAX = 128;

interface PushSong {
  name: string;
  /** First scene carrying this song, ascending — what a jump lands on. */
  scene: number;
}

let pushSongs: PushSong[] = [];
/** Last index seen from the encoder, to tell a real turn from a re-send. */
let pushSongIndex = -1;
/**
 * The label list last written to the device, joined — what makes a relabel that
 * would change nothing a no-op. `null` means "unknown, write regardless", which
 * is what the label diagnostics leave behind after writing labels of their own.
 */
let pushLabels: string | null = null;

/**
 * What joins those labels into that key.
 *
 * A NUL, because no song name can hold one and a label now *can* hold a space —
 * so joining on anything a label could contain would let two different lists
 * render identically and skip a write that was needed.
 *
 * Written as an escape rather than typed. A literal NUL in the source makes
 * `grep` and `rg` classify this whole file as binary and answer every search
 * with silence, which reads exactly like the code not being there.
 */
const PUSH_LABEL_JOIN = '\u0000';

/**
 * Strip characters Max message syntax treats specially, then fit the budget.
 *
 * **Spaces are left exactly as typed**, and used not to be. Every one was
 * swapped for U+00A0 on the guess that an atom containing a space needed
 * protecting — Cycling '74 says an item with a space "should be enclosed in
 * double quotes", but says it about the Inspector's text field, and a name
 * handed over as an atom is never parsed as text. On hardware the guess is what
 * broke: **Push has no glyph for U+00A0 and draws every one as `?`**, so a
 * two-word title reached the display as `Two?Words`. The insurance cost more
 * than the risk it was taken out against.
 *
 * The other half of the question is `diag labelspaces`, which writes both forms
 * at once — it is how "a plain space survives the outlet as one atom" stops
 * being the *new* guess. `lom.ts` measured the same thing for LiveAPI writes and
 * found one symbol (see `setName`), but Node for Max is a different path. If a
 * plain space doesn't survive it the symptom is loud rather than subtle: the
 * list arrives one atom too long per space, and every song after the first
 * two-word title sits on the wrong detent.
 */
function sanitizePushLabel(name: string): string {
  const clean = name
    // Max message syntax: separators, quoting, and `$` argument substitution.
    .replace(/[,;"$\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean === '') return '(untitled)';
  return clean.length > PUSH_LABEL_MAX ? clean.slice(0, PUSH_LABEL_MAX).trim() : clean;
}

/** A position with no song at it. Matches tools/build-device.ts. */
const PUSH_EMPTY_SLOT = '-';

/**
 * How long the labels are given to land before the bank is redefined over them.
 *
 * The write and the re-read are two messages through the same patch cord, so
 * this only has to outlast Max's own scheduling — it is not waiting on Live.
 */
const PUSH_BANK_SETTLE_MS = 50;

/**
 * Hand Push every value label at once — the whole running order, one message.
 *
 * **Once per set change, and never while anyone is playing.** Turning the
 * encoder only moves between labels that are already on the device, so there is
 * nothing to write, nothing to debounce, and no metadata churn at the moment it
 * would matter most.
 *
 * **Exactly `PUSH_SONG_MAX` items, padded with `PUSH_EMPTY_SLOT`.** The list
 * sets the same field the parameter's positions were declared with, so sending
 * the declared length is what keeps the span and the detent count the ones Push
 * was told about at load.
 *
 * **Then the bank is redefined, because Push keeps what it read.** Names
 * written while Push was already looking at the device did not appear until it
 * was restarted — it caches a control's value labels rather than re-reading
 * them. Cycling '74 documents banks as modifiable in real time "to cause
 * updates on the Push display", which is the only lever there is on that cache,
 * so every write pulls it. Redefining a page that already exists is otherwise a
 * no-op: same index, same name, same parameter.
 *
 * **A relabel that would change nothing is skipped entirely**, and that isn't
 * only thrift. One rename reaches here twice — once when the held set is
 * patched from the `apply`, and again when Live's own scene-name observer
 * answers with a delta saying the same thing — so without this the second write
 * pulls the cache lever on a list Push already has, and resets the encoder's
 * position out from under whoever is turning it. The list is the whole state,
 * so comparing the rendered labels is the honest test; `pushSongIndex` survives
 * because a position still pointing at the same song is still a valid one.
 */
function refreshPushBankStrip(): void {
  const labels = Array.from({ length: PUSH_SONG_MAX }, (_, i) => {
    const song = pushSongs[i];
    return song ? sanitizePushLabel(song.name) : PUSH_EMPTY_SLOT;
  });
  const rendered = labels.join(PUSH_LABEL_JOIN);
  if (rendered === pushLabels) {
    // Still printed: this line is how the chain is confirmed without Push
    // hardware, and a silent skip would look exactly like a broken derive.
    Max.post(`push: labels unchanged (${labels.length}) — not rewritten`);
    return;
  }
  pushLabels = rendered;
  Max.post(`push: labels -> ${labels.slice(0, 4).join(' | ')} … (${labels.length})`);
  Max.outlet('push_songs', ...labels);
  // The range is about to change under it, so nothing the encoder said before
  // now describes a song in the new list. Only on a real change: resetting it
  // for a rewrite of the same labels would drop the position mid-turn.
  pushSongIndex = -1;
  setTimeout(() => Max.outlet('push_bank'), PUSH_BANK_SETTLE_MS);
}

/** How long Live is given to notice a metadata write before it is read back. */
const DIAG_LABEL_READBACK_MS = 300;

/**
 * Send labels no song in the set could have produced. Developer diagnostic.
 *
 * The song list has been the confounder in every attempt at this: a label that
 * never appears on Push proves nothing while the walk, the derive step, the
 * sanitizer and the parameter are all still in the frame. These names come from
 * nowhere but here, so what reaches the hardware is the message and the
 * parameter alone.
 *
 * `count` is deliberately free of `PUSH_SONG_MAX`. Whether an Enum's item list
 * may change length at runtime is unrecorded in Cycling '74's docs — the
 * parameters reference says only that the Range/Enum field *is* the item list
 * for an Enum — so sending the wrong number on purpose is how that gets
 * settled. A count Max rejects and a count it accepts look identical from here;
 * the `diag param` readback afterwards is what tells them apart.
 */
function diagPushLabels(count: number, spaces: boolean): void {
  const n = spaces ? PUSH_SONG_MAX : Math.max(0, Math.min(count, 64));
  const labels = Array.from({ length: n }, (_, i) => `L${i + 1}`);
  if (spaces) {
    // The two forms a two-word title can take, side by side on the encoder.
    // Position 2 is what the labels use now; position 3 is the non-breaking
    // space they used to, kept as the control — it draws as `Two?Words`, which
    // is what retired it. If position 2 instead arrives split across two
    // detents, the plain space does not survive the outlet and the substitution
    // has to come back in some form Push can actually draw.
    if (n > 1) labels[1] = 'Two Words';
    if (n > 2) labels[2] = 'Two\u00a0Words';
  }
  Max.post(
    `push: diag labels -> ${n} item(s)` + (n ? ` — ${labels.join(' | ')}` : ' (cleared)'),
  );
  Max.outlet('push_songs', ...labels);
  // The device no longer holds what the song list last wrote, so the next real
  // relabel must not decide it has nothing to do. A diagnostic that quietly
  // disabled the next write would be the confounder this one exists to remove.
  pushLabels = null;
  // Live is not asked what it thinks until it has had a scheduler tick to
  // notice: read back in the same breath and a stale answer looks like a
  // refused write.
  setTimeout(() => Max.outlet('diag', 'param', 0), DIAG_LABEL_READBACK_MS);
}

/**
 * Rebuild the live.banks page on demand. Developer diagnostic.
 *
 * `refreshPushBankStrip` already does this after every write. This is the same
 * message on its own, for telling a label that never arrived apart from one
 * that arrived and is sitting behind Push's cache — which is a distinction that
 * cost a Push restart per test to make before the two were separable.
 */
function diagPushBank(): void {
  Max.post('push: diag bank -> clearing and redefining the live.banks page');
  Max.outlet('push_bank');
}

/**
 * Rebuild the encoder's song list from the set we hold.
 *
 * Reads the model rather than running its own `derive()`. It used to do the
 * latter, which made the mapping computed twice in this one process and a third
 * time in every browser tab — the drift `core/docs/setModel.md` exists to close.
 */
function refreshPushSongs(model: OpenFlow.SetModel): void {
  const all = model.songs
    // "First scene carrying this song" — `blocks` is ascending and a reprise is
    // a later block, so this is the start of the first run rather than of the
    // last one the walk happened to see.
    .map((s) => ({ name: s.name, scene: s.blocks[0]?.from ?? s.scenes[0]! }))
    .sort((a, b) => a.scene - b.scene);
  pushSongs = all.slice(0, PUSH_SONG_MAX);
  // A cap that silently drops songs would read as "this set has 128 songs".
  if (all.length > pushSongs.length) {
    Max.post(
      `push: ${all.length} songs, showing the first ${pushSongs.length} — ` +
        `raise PUSH_SONG_MAX in bridge.ts`,
    );
  }
  // Confirms this half of the chain independent of Push hardware: if this
  // never prints, the song list isn't the problem — the walk or the derive
  // step is. See Options > Max > Open Max Window.
  Max.post(
    `push: ${pushSongs.length} song(s) on the encoder` +
      (pushSongs.length ? ` — ${pushSongs.map((s) => s.name).join(', ')}` : ''),
  );
  refreshPushBankStrip();
}

/** Move Live's own Session View selection — the same op `selectScene` uses. */
function selectSceneOnLive(scene: number): void {
  Max.outlet('select_scene', scene);
}

/** A snapshot request with no client behind it — see `requestInternalSnapshot`. */
function trackInternal(type: OpenFlow.RequestType): number {
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
  lastAttemptAt = Date.now();
  startFlight(trackInternal('snapshot'));
}

/**
 * When a walk last succeeded, and when one was last tried. The backstop's clock.
 *
 * On this side rather than in each browser tab, because the set is this
 * process's to know. N tabs each running their own staleness timer reached the
 * same conclusion at the same moment and asked N times for the same walk, and a
 * tab that was merely *open* was what decided Live should spend ~2.6s.
 */
let lastSnapshotAt: number | null = null;
let lastAttemptAt: number | null = null;

/**
 * Look at Live again when what we hold has gone stale enough to distrust.
 *
 * For what no observer can report: properties Live exposes with no `observe` at
 * all — `Clip.length`, `Track.fold_state` — plus another M4L device or a remote
 * script. Nothing announces those, so the only way to find out is to look.
 *
 * `shouldWalk` is the same function the client used to call, still in `core/`
 * with its tests; only the caller moved. **Holding nothing is not staleness** —
 * that case belongs to `ready`, and answering false here is what stops a walk
 * that failed from being retried in a loop.
 */
function backstopTick(): void {
  if (!lomReady || snapshotFlight) return;
  if (
    !shouldWalk({
      now: Date.now(),
      lastSnapshotAt,
      lastAttemptAt,
      staleMs: STALE_MS,
      minIntervalMs: MIN_INTERVAL_MS,
    })
  ) {
    return;
  }
  Max.post('backstop: the held set is stale enough to re-read — walking Live');
  requestInternalSnapshot();
}

let backstopTimer: NodeJS.Timeout | null = null;

/**
 * Check for staleness on a fixed tick rather than on some event.
 *
 * The tick is `MIN_INTERVAL_MS`, which is also the floor `shouldWalk` enforces,
 * so at most one walk per interval however often this fires. Idempotent: a
 * device reload calls it again and it replaces the timer rather than stacking a
 * second one.
 */
function startBackstop(): void {
  if (backstopTimer) clearInterval(backstopTimer);
  backstopTimer = setInterval(backstopTick, MIN_INTERVAL_MS);
  backstopTimer.unref?.();
}

// Routed around lom.ts, same as device_state_get/set — see tools/build-device.ts.
Max.addHandler('push_song', (i: number) => {
  // Setting the range can make live.menu restate its value, and a set that
  // re-selects the song you are already on should not move Live's selection
  // out from under a running song. Only a change is a turn.
  if (i === pushSongIndex) return;
  pushSongIndex = i;
  const song = pushSongs[i];
  // Confirms this half of the chain independent of whether the jump visibly
  // did anything: if this never prints, the encoder isn't reaching bridge.ts
  // at all — the parameter wiring or live.banks is the place to look.
  if (song) {
    Max.post(`push: song ${i} -> "${song.name}" (scene ${song.scene})`);
    selectSceneOnLive(song.scene);
  } else {
    Max.post(`push: song ${i} selected with no song mapped there`);
  }
});

async function handle(ws: WebSocket, m: OpenFlow.Request): Promise<void> {
  switch (m.type) {
    case 'snapshot': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      // The whole point of holding the set: answer from memory and let Live get
      // on with whatever it is doing. `fresh` is the client saying it suspects
      // something no observer reports — the Snapshot button and the staleness
      // backstop — and that is the only thing worth a walk.
      if (!m.fresh && held) {
        Max.post(`snapshot: answered from the held set (rev ${held.snapshot.rev}) — no walk`);
        return send(ws, {
          type: 'snapshot',
          id: m.id,
          dictMs: held.dictMs,
          hostMs: held.hostMs,
          data: held.snapshot,
          model: held.model,
          cached: true,
        });
      }
      // A walk is already running. Wait for it instead of starting a second.
      if (snapshotFlight) {
        snapshotFlight.joined.push({ ws, clientId: m.id });
        return;
      }
      // Says which of the two reasons this is, because from the outside a walk
      // that had to happen and a walk that shouldn't have look identical — and
      // telling them apart is the difference between the cache working and the
      // cache being quietly defeated.
      Max.post(
        `snapshot: walking Live — ${m.fresh ? 'the client asked for a fresh read' : 'nothing is held'}`,
      );
      startFlight(track(ws, m));
      break;
    }
    case 'apply': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      const ops = Array.isArray(m.ops) ? m.ops : [];
      const sceneOps = Array.isArray(m.sceneOps) ? m.sceneOps : [];
      const reqId = track(ws, m, { kind: 'apply', ops, sceneOps });
      try {
        await Max.setDict('openflow_ops', { ops, sceneOps });
      } catch (e) {
        // Max rejects setDict for a dict that doesn't exist yet, and does it with
        // an empty message — which is how this arrived as "apply: Error" and
        // nothing else. lom.ts creates openflow_ops in ensureDicts() on init for
        // exactly this reason, so if you're reading this, suspect that ran late
        // or not at all.
        pending.delete(reqId);
        throw new Error(
          `could not stage ${ops.length + sceneOps.length} ops into openflow_ops — ` +
            `${describe(e)}. The dict must exist before Node can write it; ` +
            `lom.ts creates it on init.`,
        );
      }
      Max.outlet('apply', reqId, 'openflow_ops');
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
      const clean: OpenFlow.SceneAddition = { at, count, name };
      if (color !== undefined) clean.color = color;
      if (tempo !== undefined) clean.tempo = tempo;
      const reqId = track(ws, m);
      try {
        await Max.setDict('openflow_ops', { addition: clean });
      } catch (e) {
        pending.delete(reqId);
        throw new Error(
          `could not stage ${count} new scenes into openflow_ops — ${describe(e)}. ` +
            `The dict must exist before Node can write it; lom.ts creates it on init.`,
        );
      }
      Max.outlet('add_scenes', reqId, 'openflow_ops');
      break;
    }
    // Reordering scenes. Shares `openflow_ops` with apply — one write is in flight at
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
        await Max.setDict('openflow_ops', { plan: { create, steps, remove } });
      } catch (e) {
        pending.delete(reqId);
        throw new Error(
          `could not stage a move of ${create.length} scenes into openflow_ops — ` +
            `${describe(e)}. The dict must exist before Node can write it; ` +
            `lom.ts creates it on init.`,
        );
      }
      Max.outlet('move', reqId, 'openflow_ops');
      break;
    }
    // Slots, not scenes — see `moveClips` in the protocol. Shares `openflow_ops` with
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
      const reqId = track(ws, m, { kind: 'clips', plan: { steps, remove } });
      try {
        await Max.setDict('openflow_ops', { clipPlan: { steps, remove } });
      } catch (e) {
        pending.delete(reqId);
        throw new Error(
          `could not stage a move of ${steps.length} clips into openflow_ops — ` +
            `${describe(e)}. The dict must exist before Node can write it; ` +
            `lom.ts creates it on init.`,
        );
      }
      Max.outlet('move_clips', reqId, 'openflow_ops');
      break;
    }
    case 'palette': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      Max.outlet('palette', track(ws, m));
      break;
    }
    /**
     * Read the notes of a handful of clips. A read, like `devices` — the bridge
     * holds nothing about notes and never will, because a progression is a
     * function of what a client is asking about rather than of the set.
     *
     * Bounded here as well as in `lom.ts`: the ask travels as loose atoms, and
     * a caller that sent a thousand pairs would have Live open a thousand clips
     * inside one Max message.
     */
    case 'clipNotes': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      const asked = Array.isArray(m.clips) ? m.clips : [];
      if (asked.length === 0 || asked.length > CLIP_NOTES_MAX) {
        return send(ws, {
          type: 'error',
          id: m.id,
          message: `clipNotes takes 1–${CLIP_NOTES_MAX} clips`,
        });
      }
      const pairs: number[] = [];
      for (const clip of asked) {
        const t = Number(clip?.t);
        const s = Number(clip?.s);
        if (!Number.isInteger(t) || !Number.isInteger(s) || t < 0 || s < 0) {
          return send(ws, { type: 'error', id: m.id, message: 'clipNotes: bad clip address' });
        }
        pairs.push(t, s);
      }
      Max.outlet('clip_notes', track(ws, m), ...pairs);
      break;
    }
    // Developer diagnostics. Fire-and-forget like `observe`: no reqId, no
    // pending entry, no reply, because every answer lands in the Max window
    // instead. See the `diag` note in protocol/global.d.ts for why.
    case 'diag': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      // Two of them are answered here rather than in lom.ts, because the thing
      // under test is the Node→patcher→parameter path itself — forwarding them
      // would route the probe around the code it is probing.
      if (m.what === 'labels' || m.what === 'labelspaces') {
        diagPushLabels(Number(m.arg ?? 0), m.what === 'labelspaces');
        break;
      }
      if (m.what === 'bank') {
        diagPushBank();
        break;
      }
      Max.outlet('diag', String(m.what), Number(m.arg ?? 0));
      break;
    }
    // Device configuration is a Stored Only Max parameter. No LOM gate: it
    // belongs to this device instance and Live persists it with the .als.
    case 'saveSetConfig': {
      const roles = cleanRoles(m.roles);
      const defaultArtist = cleanDefaultArtist(m.defaultArtist);
      const stored = deviceState ?? { version: 1 as const, defaultArtist: '', roles: [] };
      // Omitted means "this client isn't saying" — an older UI still saving the
      // rest of the form must not turn a playback-affecting setting off.
      const writeSceneTempo =
        m.writeSceneTempo === undefined ? stored.writeSceneTempo : m.writeSceneTempo === true;
      await publishDeviceState({
        ...stored,
        defaultArtist,
        roles,
        writeSceneTempo,
      });
      Max.post(
        `device state: ${roles.length} role(s), ` +
          `${defaultArtist === '' ? 'no default artist' : `default artist ${defaultArtist}`}` +
          `${writeSceneTempo ? ', scene tempo on rename' : ''}`,
      );
      send(ws, {
        type: 'setConfigSaved',
        id: m.id,
        defaultArtist,
        roleCount: roles.length,
      });
      break;
    }
    case 'saveAllowedColors': {
      const colors = cleanAllowedColors(m.colors);
      await publishDeviceState({
        ...(deviceState ?? { version: 1 as const, defaultArtist: '', roles: [] }),
        allowedColors: colors,
      });
      send(ws, { type: 'allowedColorsSaved', id: m.id, colors });
      break;
    }
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
      const patch: OpenFlow.TransportPatch = {};
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
      if (source.recordMode !== undefined) {
        if (typeof source.recordMode !== 'boolean') {
          return send(ws, { type: 'error', id: m.id, message: 'record mode must be boolean' });
        }
        patch.recordMode = source.recordMode;
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
    case 'watchChains': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      const bad = setChainWatch(ws, m.subs);
      if (bad) return send(ws, { type: 'error', id: m.id, message: bad });
      break;
    }
    case 'setMixer': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      const sourceTarget = m.target;
      let target: OpenFlow.MixerTarget;
      if (sourceTarget?.kind === 'master') {
        target = { kind: 'master' };
      } else if (sourceTarget?.kind === 'track') {
        const t = Number(sourceTarget.t);
        if (!Number.isInteger(t) || t < 0) {
          return send(ws, { type: 'error', id: m.id, message: 'invalid mixer track' });
        }
        target = { kind: 'track', t };
      } else {
        return send(ws, { type: 'error', id: m.id, message: 'invalid mixer target' });
      }

      const source = m.patch;
      if (!source || typeof source !== 'object') {
        return send(ws, { type: 'error', id: m.id, message: 'mixer patch is missing' });
      }
      const patch: OpenFlow.MixerPatch = {};
      for (const field of ['active', 'solo', 'armed'] as const) {
        if (source[field] === undefined) continue;
        if (typeof source[field] !== 'boolean') {
          return send(ws, {
            type: 'error',
            id: m.id,
            message: `${field} must be boolean`,
          });
        }
        patch[field] = source[field];
      }
      for (const field of ['volume', 'pan'] as const) {
        if (source[field] === undefined) continue;
        const value = Number(source[field]);
        // Parameter ranges differ (volume is 0–1, pan is -1–1 in the current
        // Live runtime). lom.ts checks the resolved parameter's actual bounds.
        if (!Number.isFinite(value)) {
          return send(ws, { type: 'error', id: m.id, message: `${field} must be numeric` });
        }
        patch[field] = value;
      }
      if (source.send !== undefined) {
        if (!source.send || typeof source.send !== 'object') {
          return send(ws, { type: 'error', id: m.id, message: 'send must be an object' });
        }
        const index = Number(source.send.index);
        const value = Number(source.send.value);
        if (!Number.isInteger(index) || index < 0) {
          return send(ws, { type: 'error', id: m.id, message: 'invalid send index' });
        }
        if (!Number.isFinite(value)) {
          return send(ws, { type: 'error', id: m.id, message: 'send must be numeric' });
        }
        patch.send = { index, value };
      }
      if (Object.keys(patch).length === 0) {
        return send(ws, { type: 'error', id: m.id, message: 'mixer patch is empty' });
      }
      if (
        target.kind === 'master' &&
        (patch.active !== undefined || patch.solo !== undefined || patch.armed !== undefined ||
          patch.send !== undefined)
      ) {
        return send(ws, {
          type: 'error',
          id: m.id,
          message: 'Master exposes volume and pan only',
        });
      }
      // One patch per strip operation. The observer readback is the
      // acknowledgement, including Live's accepted volume value.
      Max.outlet('set_mixer', encodeMaxAtom({ target, patch }));
      break;
    }
    /**
     * One device write, validated here and acknowledged by the watch.
     *
     * The address is checked for *shape* only — an even path of non-negative
     * integers. Whether it resolves is the LOM side's to answer, because only
     * that side can: a device's address is its position, and positions move.
     * Rejecting a plausible one here would mean keeping a second copy of the
     * set's device tree in this process, which is exactly what the watch model
     * exists to avoid.
     */
    case 'setDevice': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      const source = m.target;
      if (!source || typeof source !== 'object') {
        return send(ws, { type: 'error', id: m.id, message: 'device target is missing' });
      }
      const t = Number(source.t);
      const i = Number(source.i);
      if (!Number.isInteger(t) || t < 0) {
        return send(ws, { type: 'error', id: m.id, message: 'invalid device track' });
      }
      if (!Number.isInteger(i) || i < 0) {
        return send(ws, { type: 'error', id: m.id, message: 'invalid device index' });
      }
      if (!Array.isArray(source.path) || source.path.length % 2 !== 0) {
        return send(ws, { type: 'error', id: m.id, message: 'invalid device path' });
      }
      const path: number[] = [];
      for (const step of source.path) {
        const value = Number(step);
        if (!Number.isInteger(value) || value < 0) {
          return send(ws, { type: 'error', id: m.id, message: 'invalid device path' });
        }
        path.push(value);
      }
      const target: OpenFlow.DeviceTarget = { t, path, i };

      const patchSource = m.patch;
      if (!patchSource || typeof patchSource !== 'object') {
        return send(ws, { type: 'error', id: m.id, message: 'device patch is missing' });
      }
      const patch: OpenFlow.DevicePatch = {};
      for (const field of ['on', 'folded'] as const) {
        if (patchSource[field] === undefined) continue;
        if (typeof patchSource[field] !== 'boolean') {
          return send(ws, { type: 'error', id: m.id, message: `${field} must be boolean` });
        }
        patch[field] = patchSource[field];
      }
      if (patchSource.param !== undefined) {
        const param = patchSource.param;
        if (!param || typeof param !== 'object') {
          return send(ws, { type: 'error', id: m.id, message: 'param must be an object' });
        }
        const p = Number(param.p);
        const value = Number(param.value);
        if (!Number.isInteger(p) || p < 0) {
          return send(ws, { type: 'error', id: m.id, message: 'invalid parameter index' });
        }
        // The range is the parameter's own and differs per control, so it is
        // checked where the parameter is: lom.ts reads its min and max.
        if (!Number.isFinite(value)) {
          return send(ws, { type: 'error', id: m.id, message: 'parameter must be numeric' });
        }
        patch.param = { p, value };
      }
      if (Object.keys(patch).length === 0) {
        return send(ws, { type: 'error', id: m.id, message: 'device patch is empty' });
      }
      Max.outlet('set_device', encodeMaxAtom({ target, patch }));
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
    // The footer already shows this track's chain. Tell Live to select the same
    // one, so its own device view is looking at what we are.
    case 'selectTrack': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      const t = Number(m.t);
      if (!Number.isInteger(t) || t < 0) {
        return send(ws, { type: 'error', id: m.id, message: 'invalid track index' });
      }
      Max.outlet('select_track', t);
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
    case 'watchStatus':
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      setWatch(ws, 'status', m.on);
      break;
    case 'watchSends':
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      setWatch(ws, 'sends', m.on);
      break;
    case 'watchTransport':
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      setWatch(ws, 'transport', m.on);
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
      ` · ${
        restored.defaultArtist === ''
          ? 'no default artist'
          : `default artist ${restored.defaultArtist}`
      }` +
      (restored.allowedColors === undefined
        ? ' · awaiting allowed-color migration'
        : ` · ${restored.allowedColors === null ? 'all' : restored.allowedColors.length} allowed color(s)`),
  );
});

Max.addHandler('ready', () => {
  lomReady = true;
  Max.post('LOM ready');
  // A walk that was running belonged to a lom.ts that no longer exists, so
  // nothing will ever answer it. Everything below re-arms; without this the
  // flight is the one thing that does not, and every later snapshot joins it.
  if (snapshotFlight) failFlight(snapshotFlight.reqId, 'the LOM restarted mid-walk');
  // `rev` is a counter inside `lom.ts` and a reloaded device starts it again at
  // zero, so anything we hold is from a sequence that no longer runs — every
  // later delta would line up against it by accident rather than by agreement.
  dropHeld('the LOM restarted, so its revision counter began again');
  broadcast({ type: 'status', lomReady: true });
  showConnections(); // off the -1 holding state and onto a real count

  // Follow Live for our own sake, before anyone asks and whether or not anyone
  // ever does. This is what makes the held set a thing the device maintains
  // rather than a thing the first browser pays to create.
  armDeviceWatches();
  startBackstop();
  // A reloaded device has empty observer lists but our record of who wants what
  // survived, so put back whatever clients were already holding.
  rearmWatches();
  // Only needed when the pattr is empty and an old bsv.json may need importing.
  Max.outlet('set_info');
  // Read the set once, here. Every later client is answered from this.
  requestInternalSnapshot();
});

/**
 * A reply from lom.ts that could not be read.
 *
 * Every handler below awaits a Dict and then reads the payload's shape bare, so
 * a name that is already gone or a dict in the wrong shape is an unhandled
 * rejection — and in Node for Max that is the device dead with its status line
 * still reading whatever count it was last given. The client that asked is told,
 * rather than left waiting out its request timeout, and any walk riding on the
 * same id fails with it.
 */
function lomReplyFailed(
  what: string,
  reqId: number,
  req: Pending | undefined,
  e: unknown,
  // `snapshot_done` takes its flight before the read it may fail on, so it hands
  // the joiners over rather than asking for a flight that is already cleared.
  joined = takeFlight(reqId),
): void {
  const message = `${what}: ${describe(e)}`;
  Max.post(`reply failed — ${message}`);
  if (req?.ws) send(req.ws, { type: 'error', id: req.clientId, message });
  for (const j of joined) send(j.ws, { type: 'error', id: j.clientId, message });
}

/**
 * Locate an old per-set bsv.json for one-time migration.
 *
 * `filePath` is the `.als`; the old vocabulary sits in its folder. This query
 * runs once when the LOM becomes ready and is irrelevant after a pattr restores.
 */
Max.addHandler('set_info_done', async (dictName: string) => {
  let info: { filePath?: string; name?: string } = {};
  try {
    info = await Max.getDict(dictName);
  } catch (e) {
    // An unreadable reply means the same thing an empty one does — nothing is
    // known about where the set lives — and the migration still has to be let
    // off its hook or it waits for a reply that already came.
    Max.post(`set_info_done: could not read ${dictName} — ${describe(e)}`);
  }
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
  // Read before `takeFlight` clears it. A `snapshot_done` with no flight is a
  // stray or a duplicate, and -1 refuses to hold what it carries.
  const walkedGeneration = snapshotFlight?.reqId === reqId ? snapshotFlight.generation : -1;
  const flight = takeFlight(reqId);
  try {
    await snapshotDone(req, dictName, dictMs, walkedGeneration, flight);
  } catch (e) {
    lomReplyFailed('snapshot_done', reqId, req, e, flight);
  }
});

async function snapshotDone(
  req: Pending | undefined,
  dictName: string,
  dictMs: number,
  walkedGeneration: number,
  flight: Array<{ ws: WebSocket; clientId?: number }>,
): Promise<void> {
  const t0 = Date.now();
  const data: OpenFlow.Snapshot = await Max.getDict(dictName);
  const hostMs = Date.now() - t0;
  // Read the mapping once, here, and ship it. Every client used to run the same
  // `derive()` over the same scene names to draw its own grid — see
  // `core/docs/setModel.md`.
  const model = buildSetModel(derive(data.scenes, SCENE_PATTERNS), data.rev);
  // The whole payload is kept, not just its scenes: it is what the next client
  // to ask is answered with — but only if the set is still the one this walk
  // read. A walk that started before an invalidation still answers whoever
  // asked for it, and they re-read on the structural change that follows;
  // holding it would outlive that and be handed to everyone after them. Push is
  // not relabelled from it either, for the same reason.
  if (walkedGeneration === heldGeneration) {
    held = { snapshot: data, model, dictMs, hostMs };
    // Only a walk we kept resets the clock. One we answered but couldn't hold
    // proves nothing about what we know now — see `backstopTick`.
    lastSnapshotAt = Date.now();
    refreshPushSongs(model);
  } else {
    Max.post('snapshot: the set changed while this walk ran — answering it, but not holding it');
  }
  const t = data.timings;
  // `elapsed` beside `ms` rather than instead of it: one is what Live spent
  // reading, the other is what the user waited, and the gap between them is the
  // time the chunked walk handed back to Live's UI. Tuning `SNAP_CHUNK` means
  // watching that gap, so it has to be on screen.
  Max.post(
    `snapshot: ${data.clipCount} clips in ${data.ms}ms lom over ${t.elapsed}ms ` +
      `(tracks ${t.tracks} · scenes ${t.scenes} · ${t.slotsScanned} slots ${t.slots} · clips ${t.clips}` +
      `${t.restarts > 0 ? ` · ${t.restarts} restarts` : ''}) ` +
      `+ ${dictMs}ms dict + ${hostMs}ms host`,
  );
  const event: OpenFlow.Event = {
    type: 'snapshot',
    id: req?.clientId,
    dictMs,
    hostMs,
    data,
    model,
    cached: false,
  };
  // `req` is always set (`pending` always held an entry) except on a stray or
  // duplicate `snapshot_done`; a request this bridge made of itself (no `ws`,
  // see `requestInternalSnapshot`) has already gotten what it needed above and
  // broadcasting it again to every client would be a wasted duplicate.
  if (req?.ws) send(req.ws, event);
  else if (!req) broadcast(event);
  // Everyone who asked while this was running. Each needs the payload under its
  // own request id — that id is what resolves the waiter on the other end, so
  // one shared event object would answer exactly one of them.
  for (const j of flight) {
    send(j.ws, { type: 'snapshot', id: j.clientId, dictMs, hostMs, data, model, cached: false });
  }
  if (flight.length > 0) {
    // The originator counts only when it was a client. A walk the bridge asked
    // for itself has no socket behind it, and reporting it as a client is how
    // "one walk answered 2 clients" appeared with a single tab open — which
    // reads as a phantom connection rather than as the bridge doing its job.
    const asked = flight.length + (req?.ws ? 1 : 0);
    Max.post(
      `snapshot: one walk answered ${asked} client(s)` +
        (req?.ws ? '' : ', plus the bridge’s own request'),
    );
  }
}

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

/**
 * Patch the held set with a write Live has just taken in full.
 *
 * The same bargain the client makes: **everything landed, or nothing is
 * assumed.** `apply` answers with counts and never says *which* ops it skipped,
 * so a partial write cannot be reproduced here and doesn't try to be — the held
 * set goes instead, and the next request walks Live.
 */
function patchHeldWithApply(req: Pending | undefined, result: OpenFlow.ApplyResult): void {
  if (!held) return;
  if (req?.written?.kind !== 'apply') {
    dropHeld('an apply finished with no record of what it wrote');
    return;
  }
  if (result.applied !== result.total) {
    dropHeld(`Live took ${result.applied} of ${result.total} ops and did not say which`);
    return;
  }
  const { ops, sceneOps } = req.written;
  const scenes = applySceneOps(held.snapshot.scenes, sceneOps);
  held.snapshot = {
    ...held.snapshot,
    clips: applyOps(held.snapshot.clips, ops, (i) => LIVE_PALETTE[i]),
    scenes,
  };
  // A scene name *is* the mapping, so a rename changes the songs. Clip writes
  // never do.
  if (sceneOps.length > 0) held.model = rereadModel(held.snapshot.rev, scenes);
}

Max.addHandler('apply_done', async (reqId: number, dictName: string, ms: number) => {
  const req = pending.get(reqId);
  pending.delete(reqId);
  try {
    const result: OpenFlow.ApplyResult = await Max.getDict(dictName);
    patchHeldWithApply(req, result);
    Max.post(`apply: ${result.applied} written, ${result.skipped} skipped, ${ms}ms`);
    send(req?.ws, { type: 'applied', id: req?.clientId, lomMs: ms, ...result });
    broadcast({ type: 'changed', kind: 'applied' });
  } catch (e) {
    // What Live took is unknown, which is exactly the case `patchHeldWithApply`
    // drops the held set for.
    dropHeld('an apply finished with a reply that could not be read');
    lomReplyFailed('apply_done', reqId, req, e);
  }
});

Max.addHandler('add_scenes_done', async (reqId: number, dictName: string, ms: number) => {
  const req = pending.get(reqId);
  pending.delete(reqId);
  try {
    const r: OpenFlow.ScenesAddedResult = await Max.getDict(dictName);
    Max.post(
      `addScenes: ${r.created} created, ${r.configured} configured, ` +
        `${r.failed} failed, ${ms}ms` +
        (r.undoStep ? ' (one undo step)' : ' (NOT grouped in Live undo)'),
    );
    send(req?.ws, { type: 'scenesAdded', id: req?.clientId, lomMs: ms, ...r });
  } catch (e) {
    lomReplyFailed('add_scenes_done', reqId, req, e);
  }
  // Outside the catch: scenes may well have been inserted whether or not the
  // count came back, and every index at or below the insertion point moved.
  // Other clients must discard their snapshots before another click can address
  // the old row, and so must we — this renumbers the set rather than editing it.
  dropHeld('scenes were inserted, which renumbers the set');
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
  try {
    const r: { copied: number; removed: number; failed: number; undoStep: boolean } =
      await Max.getDict(dictName);
    // Every index still means what it meant, so the plan alone says where each
    // clip ended up — unless something failed, because `lom.ts` then skips the
    // whole delete pass and the set holds both copies, which the plan does not
    // describe. Slots only: no scene name moved, so the model still stands.
    if (held) {
      if (req?.written?.kind !== 'clips' || r.failed > 0) {
        dropHeld(
          r.failed > 0
            ? `${r.failed} of ${r.copied + r.failed} clip copies failed, so nothing was deleted`
            : 'a clip move finished with no record of what it moved',
        );
      } else {
        const clips = applyClipMove(held.snapshot.clips, req.written.plan);
        held.snapshot = { ...held.snapshot, clips, clipCount: clips.length };
      }
    }
    Max.post(
      `moveClips: ${r.copied} copied, ${r.removed} deleted, ${r.failed} failed, ${ms}ms` +
        (r.undoStep ? ' (one undo step)' : ' (NOT undoable in Live)'),
    );
    send(req?.ws, { type: 'clipsMoved', id: req?.clientId, lomMs: ms, ...r });
  } catch (e) {
    dropHeld('a clip move finished with a reply that could not be read');
    lomReplyFailed('move_clips_done', reqId, req, e);
  }
  // Not structural the way a scene move is — every index still means what it
  // meant — but the grid's contents moved, so other clients are showing clips
  // where there aren't any.
  broadcast({ type: 'changed', kind: 'clipsMoved' });
});

Max.addHandler('move_done', async (reqId: number, dictName: string, ms: number) => {
  const req = pending.get(reqId);
  pending.delete(reqId);
  try {
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
  } catch (e) {
    lomReplyFailed('move_done', reqId, req, e);
  }
  // Outside the catch, and structural, so every client's scene indexes just
  // became wrong whether or not the counts came back. This is the
  // one change where a stale grid is actively dangerous rather than merely out
  // of date — a click lands on a different scene than it looks like.
  //
  // `structure`, not `moved`: the client re-walks on `structure` and only logs
  // `moved`, so the old kind announced the danger to a handler that did nothing
  // about it. What actually recovered other clients was the observer burst
  // during the move — which had them walking a set that was halfway rearranged.
  // That burst is muted in `lom.ts` now, and this is the one event in its place.
  dropHeld('scenes were reordered, which renumbers the set');
  broadcast({ type: 'changed', kind: 'structure' });
  requestInternalSnapshot();
});

Max.addHandler('clip_notes_done', async (reqId: number, dictName: string, ms: number) => {
  const req = pending.get(reqId);
  pending.delete(reqId);
  try {
    const payload: { clips?: OpenFlow.ClipNotes[] } = await Max.getDict(dictName);
    const clips = Array.isArray(payload?.clips) ? payload.clips : [];
    const notes = clips.reduce((n, clip) => n + (clip.notes?.length ?? 0), 0);
    Max.post(`clip notes: ${notes} notes from ${clips.length} clips in ${ms}ms`);
    send(req?.ws, { type: 'clipNotes', id: req?.clientId, clips });
  } catch (e) {
    lomReplyFailed('clip_notes_done', reqId, req, e);
  }
});

Max.addHandler('palette_done', async (reqId: number, dictName: string) => {
  const req = pending.get(reqId);
  pending.delete(reqId);
  try {
    const p: OpenFlow.Palette = await Max.getDict(dictName);
    Max.post(`palette diagnostic: ${p.count} colors extracted (not persisted)`);
    send(req?.ws, { type: 'palette', id: req?.clientId, ...p });
  } catch (e) {
    lomReplyFailed('palette_done', reqId, req, e);
  }
});

Max.addHandler('changed', (kind: string) => {
  if (kind === 'structure') {
    // Arming `observe` installs two LiveAPI observers and each calls back once
    // with the value it already had. That is not a structural change, and
    // treating it as one threw away the held set every time a browser
    // connected — including the walk the device had started for itself.
    if (takeStructureEcho()) {
      Max.post('changed: structure — the echo of arming the observers, ignored');
      return;
    }
    // A track or scene was added, removed or reordered *in Live*, so every index
    // means something different and nothing we hold can be patched into the set
    // that now exists. Every client re-walks on this; so do we.
    dropHeld('Live reported a structural change');
    // And then go and look, rather than leaving the next client to pay for it.
    // The set is the bridge's job to know; a tab that opens after a track was
    // added should still be a payload. The walk coalesces with any client
    // request that arrives while it runs.
    requestInternalSnapshot();
  }
  broadcast({ type: 'changed', kind });
});

// A partial re-read, pushed because the user changed something in Live rather
// than because anyone asked. Broadcast: every client holds the same set, and a
// delta is far cheaper than each of them walking it. Unlike the realtime pushes
// below this carries clip names, so it travels by Dict — names contain spaces,
// commas and semicolons, all special in Max messages.
Max.addHandler('delta', async (dictName: string) => {
  try {
    const data: OpenFlow.SnapshotDelta = await Max.getDict(dictName);
    Max.post(
      `delta: ${data.clips.length} clip(s) across track(s) ` +
        `${data.clipScope.join(', ')} in ${data.ms}ms (rev ${data.prevRev} -> ${data.rev})`,
    );
    // The same merge every client runs, over the copy this process holds — one
    // set of arithmetic in `core/` with tests, not two. `rev` advances on every
    // delta regardless of what it touched, so it is taken whenever the check
    // passes and not only on the deltas with rows to merge.
    //
    // A mismatch means a message was missed, and there is no way to tell what
    // was in it. Drop everything rather than merge against the wrong revision:
    // the next request walks Live, and until then Push keeps the song list it
    // has. A rename is exactly this path — `apply` broadcasts
    // `changed: 'applied'` rather than `'structure'`, so a delta is what says
    // scene names, and therefore the song list, moved under us.
    let model: OpenFlow.SetModel | undefined;
    if (held) {
      if (!canApplyDelta(held.snapshot.rev, data.prevRev)) {
        dropHeld(`a delta computed against rev ${data.prevRev} arrived while ` +
          `holding rev ${held.snapshot.rev}, so a message was missed`);
      } else {
        const s = held.snapshot;
        const clips = mergeTrackDelta(s.clips, data.clipScope, data.clips);
        held.snapshot = {
          ...s,
          rev: data.rev,
          clips,
          clipCount: clips.length,
          scenes: mergeRows(s.scenes, data.sceneRows ?? []),
          tracks: mergeRows(s.tracks, data.trackRows ?? []),
          tempo: data.tempo ?? s.tempo,
          masterColor: data.masterColor === undefined ? s.masterColor : data.masterColor,
        };
        // Only when the scene rows moved. Everything in the model is a function
        // of scene names and `Scene.tempo`, so a clip-only delta cannot change
        // it — and re-sending the whole song list to say nothing changed is the
        // chatty design the coarse-grained rule exists to prevent.
        if (data.sceneRows) {
          model = rereadModel(data.rev, held.snapshot.scenes);
          held.model = model;
        }
      }
    }
    broadcast(model ? { type: 'delta', data, model } : { type: 'delta', data });
  } catch (e) {
    // A delta that can't be read is not worth failing a client over — the
    // client re-walks whenever a rev doesn't line up, so the worst case here
    // is one skipped update rather than a wrong grid.
    Max.post(`delta: could not read ${dictName} — ${describe(e)}`);
  }
});

// Flat atoms, not a Dict: this pushes on every play-state change, and a global
// dict name would race itself. See the note above `playStateAtoms` in lom.ts.
// Shape: isPlaying, then (playing, fired, armed) per track in track order.
Max.addHandler('play_state', (...args: number[]) => {
  const tracks: OpenFlow.TrackPlayState[] = [];
  for (let i = 1; i + 2 < args.length; i += 3) {
    tracks.push({
      playing: Number(args[i]),
      fired: Number(args[i + 1]),
      armed: Number(args[i + 2]) === 1,
    });
  }
  broadcast({ type: 'playState', isPlaying: Number(args[0]) === 1, tracks });
});

// One coherent frame: master first, then track/level pairs. lom.ts updates the
// values from independent observers and sends every latest value together.
Max.addHandler('meter_levels', (...args: number[]) => {
  const master = Number(args[0]);
  if (!Number.isFinite(master)) return;
  const tracks: OpenFlow.TrackMeterLevel[] = [];
  for (let i = 1; i + 1 < args.length; i += 2) {
    const t = Number(args[i]);
    const level = Number(args[i + 1]);
    if (!Number.isFinite(t) || !Number.isFinite(level)) continue;
    tracks.push({ t, level });
  }
  broadcast({ type: 'meterLevels', frame: { master, tracks } });
});

// Nine atoms per track that has a clip playing, and nothing at all for the rest
// — see `clipStatusAtoms` in lom.ts. Flat atoms for the same reason play_state
// uses them: this pushes many times a second, and a global dict name would race
// itself. Every field is a plain number, so there is no punctuation to survive.
const CLIP_STATUS_FIELDS = 9;

Max.addHandler('clip_status', (...args: number[]) => {
  const tracks: OpenFlow.PlayingClip[] = [];
  for (let i = 0; i + CLIP_STATUS_FIELDS <= args.length; i += CLIP_STATUS_FIELDS) {
    const t = Number(args[i]);
    const position = Number(args[i + 1]);
    const loopStart = Number(args[i + 2]);
    const loopEnd = Number(args[i + 3]);
    // A track index that isn't one would land this frame's clip on some other
    // column. Drop the entry rather than the frame: the rest of it is fine.
    if (!Number.isInteger(t) || t < 0) continue;
    if (!Number.isFinite(position) || !Number.isFinite(loopStart) || !Number.isFinite(loopEnd)) {
      continue;
    }
    tracks.push({
      t,
      position,
      loopStart,
      loopEnd,
      looping: Number(args[i + 4]) === 1,
      recording: Number(args[i + 5]) === 1,
      inSeconds: Number(args[i + 6]) === 1,
      signatureNumerator: Number(args[i + 7]),
      signatureDenominator: Number(args[i + 8]),
    });
  }
  broadcast({ type: 'clipStatus', frame: { tracks } });
});

function mixerParameter(value: unknown): OpenFlow.MixerParameterState | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const parameter = value as Partial<OpenFlow.MixerParameterState>;
  if (
    !Number.isFinite(parameter.value) ||
    !Number.isFinite(parameter.min) ||
    !Number.isFinite(parameter.max) ||
    !Number.isFinite(parameter.defaultValue) ||
    parameter.min! > parameter.max! ||
    parameter.value! < parameter.min! ||
    parameter.value! > parameter.max! ||
    parameter.defaultValue! < parameter.min! ||
    parameter.defaultValue! > parameter.max! ||
    typeof parameter.display !== 'string' ||
    typeof parameter.enabled !== 'boolean'
  ) {
    return undefined;
  }
  return parameter as OpenFlow.MixerParameterState;
}

// Mixer controls change far less often than levels, but parameter automation can
// still move continuously. lom.ts coalesces callbacks and sends one complete,
// punctuation-safe state so independent property observers cannot tear a strip.
/**
 * The watched runs, re-read after something in one of them changed.
 *
 * Validated with the same `chainDevice` the one-shot read uses, and rejected
 * **whole** on anything malformed rather than half-drawn. A run whose `devices`
 * is null is a real answer — the run has gone — so null passes and only a wrong
 * *shape* is refused.
 */
Max.addHandler('chain_state', (...atoms: unknown[]) => {
  const value = decodeMaxAtom(atoms.map(String).join(''));
  if (!value || typeof value !== 'object' || !Array.isArray((value as OpenFlow.ChainState).chains)) {
    Max.post('chain_state: malformed payload from lom');
    return;
  }
  const chains: OpenFlow.WatchedChain[] = [];
  for (const raw of (value as OpenFlow.ChainState).chains) {
    const source = raw as Partial<OpenFlow.WatchedChain>;
    if (
      !Number.isInteger(source.t) ||
      !Array.isArray(source.path) ||
      !source.path.every((n) => Number.isInteger(n) && n >= 0)
    ) {
      Max.post('chain_state: invalid run address from lom');
      return;
    }
    if (source.devices === null || source.devices === undefined) {
      chains.push({ t: source.t as number, path: source.path as number[], devices: null });
      continue;
    }
    if (!Array.isArray(source.devices)) {
      Max.post('chain_state: invalid devices from lom');
      return;
    }
    const devices: OpenFlow.ChainDevice[] = [];
    for (const rawDevice of source.devices) {
      const checked = chainDevice(rawDevice, 0);
      if (!checked) {
        Max.post('chain_state: invalid device from lom');
        return;
      }
      devices.push(checked);
    }
    chains.push({ t: source.t as number, path: source.path as number[], devices });
  }
  broadcast({ type: 'chainState', state: { chains } });
});

/**
 * Controls that moved since the last frame.
 *
 * Validated per change and **dropped individually** rather than rejecting the
 * batch, which is the opposite of how `chain_state` is treated and deliberately
 * so: that one describes structure, where a half-drawn chain is a lie, while
 * this is a stream of independent values where one bad entry costs one stale
 * knob until the next time it moves.
 */
Max.addHandler('chain_values', (...atoms: unknown[]) => {
  const value = decodeMaxAtom(atoms.map(String).join(''));
  const raw = (value as { changes?: unknown })?.changes;
  if (!Array.isArray(raw)) {
    Max.post('chain_values: malformed payload from lom');
    return;
  }
  const changes: OpenFlow.ChainValueChange[] = [];
  for (const entry of raw) {
    const change = entry as Partial<OpenFlow.ChainValueChange>;
    if (
      !Number.isInteger(change.t) ||
      !Array.isArray(change.path) ||
      !change.path.every((n) => Number.isInteger(n) && n >= 0) ||
      !Number.isInteger(change.i) ||
      !Number.isInteger(change.p) ||
      typeof change.value !== 'number' ||
      !Number.isFinite(change.value)
    ) {
      continue;
    }
    changes.push({
      t: change.t as number,
      path: change.path as number[],
      i: change.i as number,
      p: change.p as number,
      value: change.value,
      display: typeof change.display === 'string' ? change.display : '',
    });
  }
  if (changes.length === 0) return;
  broadcast({ type: 'chainValues', changes });
});

Max.addHandler('mixer_state', (...atoms: unknown[]) => {
  const value = decodeMaxAtom(atoms.map(String).join(''));
  if (!value || typeof value !== 'object') {
    Max.post('mixer_state: malformed payload from lom');
    return;
  }
  const source = value as Partial<OpenFlow.MixerState>;
  const sendCount = Number(source.sendCount);
  const masterVolume = mixerParameter(source.masterVolume);
  const masterPan = mixerParameter(source.masterPan);
  if (
    !Number.isInteger(sendCount) || sendCount < 0 ||
    masterVolume === undefined || masterPan === undefined || !Array.isArray(source.tracks)
  ) {
    Max.post('mixer_state: invalid top-level fields from lom');
    return;
  }
  const tracks: OpenFlow.MixerTrackState[] = [];
  for (const raw of source.tracks) {
    if (!raw || typeof raw !== 'object') return;
    const track = raw as Partial<OpenFlow.MixerTrackState>;
    const volume = mixerParameter(track.volume);
    const pan = mixerParameter(track.pan);
    const sends = Array.isArray(track.sends) ? track.sends.map(mixerParameter) : null;
    if (
      !Number.isInteger(track.t) || track.t! < 0 ||
      typeof track.active !== 'boolean' ||
      typeof track.solo !== 'boolean' ||
      typeof track.armed !== 'boolean' ||
      typeof track.canArm !== 'boolean' ||
      volume === undefined ||
      pan === undefined ||
      !sends || sends.length !== sendCount || sends.some((parameter) => parameter === undefined)
    ) {
      Max.post('mixer_state: invalid track fields from lom');
      return;
    }
    tracks.push({
      t: track.t!,
      active: track.active,
      solo: track.solo,
      armed: track.armed,
      canArm: track.canArm,
      volume,
      pan,
      sends: sends as (OpenFlow.MixerParameterState | null)[],
    });
  }
  broadcast({ type: 'mixerState', state: { sendCount, masterVolume, masterPan, tracks } });
});

/**
 * One device out of a chain, checked field by field.
 *
 * `undefined` means "lom sent something that isn't a device" and fails the whole
 * payload, the way a bad mixer strip does. The recursion is bounded on the other
 * side of the wire — `DEVICE_DEPTH_MAX` in `lom.ts` — but this walks whatever
 * arrives, so it carries its own floor rather than trusting that one.
 */
/**
 * One control, checked.
 *
 * `defaultValue` and `items` are each absent for a real reason — Live exposes a
 * default only for continuous parameters and members only for quantized ones —
 * so absence passes and only a wrong *type* is refused.
 */
function deviceParameter(raw: unknown): OpenFlow.DeviceParameterState | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Partial<OpenFlow.DeviceParameterState>;
  const number = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  if (
    typeof source.name !== 'string' ||
    !number(source.value) || !number(source.min) || !number(source.max) ||
    typeof source.quantized !== 'boolean' ||
    typeof source.display !== 'string' ||
    !number(source.state)
  ) {
    return undefined;
  }
  const parameter: OpenFlow.DeviceParameterState = {
    name: source.name,
    value: source.value as number,
    min: source.min as number,
    max: source.max as number,
    quantized: source.quantized,
    display: source.display,
    state: source.state as number,
  };
  if (source.defaultValue !== undefined) {
    if (!number(source.defaultValue)) return undefined;
    parameter.defaultValue = source.defaultValue;
  }
  if (source.items !== undefined) {
    if (!Array.isArray(source.items) || !source.items.every((i) => typeof i === 'string')) {
      return undefined;
    }
    parameter.items = source.items;
  }
  return parameter;
}

function chainDevice(raw: unknown, depth: number): OpenFlow.ChainDevice | undefined {
  if (!raw || typeof raw !== 'object' || depth > 8) return undefined;
  const source = raw as Partial<OpenFlow.ChainDevice>;
  if (
    typeof source.name !== 'string' ||
    typeof source.className !== 'string' ||
    typeof source.on !== 'boolean' ||
    typeof source.folded !== 'boolean'
  ) {
    return undefined;
  }
  const device: OpenFlow.ChainDevice = {
    name: source.name,
    className: source.className,
    on: source.on,
    folded: source.folded,
  };
  if (source.parameters !== undefined) {
    if (!Array.isArray(source.parameters)) return undefined;
    const parameters: OpenFlow.DeviceParameterState[] = [];
    for (const rawParameter of source.parameters) {
      const parameter = deviceParameter(rawParameter);
      if (!parameter) return undefined;
      parameters.push(parameter);
    }
    device.parameters = parameters;
  }
  if (source.chains === undefined) return device;
  if (!Array.isArray(source.chains)) return undefined;
  const chains: OpenFlow.RackChain[] = [];
  for (const rawChain of source.chains) {
    if (!rawChain || typeof rawChain !== 'object') return undefined;
    const chain = rawChain as Partial<OpenFlow.RackChain>;
    if (typeof chain.name !== 'string') return undefined;
    // No `devices` means nobody is subscribed to this chain, which is the
    // normal state of every chain in an unopened rack — not a malformed one.
    if (chain.devices === undefined) {
      chains.push({ name: chain.name });
      continue;
    }
    if (!Array.isArray(chain.devices)) return undefined;
    const devices: OpenFlow.ChainDevice[] = [];
    for (const nested of chain.devices) {
      const checked = chainDevice(nested, depth + 1);
      if (!checked) return undefined;
      devices.push(checked);
    }
    chains.push({ name: chain.name, devices });
  }
  device.chains = chains;
  return device;
}

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
  const state = value as Partial<OpenFlow.TransportState>;
  if (
    !Number.isFinite(state.tempo) || state.tempo! < 20 || state.tempo! > 999 ||
    typeof state.metronome !== 'boolean' ||
    !Number.isInteger(state.clipTriggerQuantization) ||
    state.clipTriggerQuantization! < 0 || state.clipTriggerQuantization! > 13 ||
    typeof state.recordMode !== 'boolean' ||
    !Number.isInteger(state.rootNote) || state.rootNote! < 0 || state.rootNote! > 11 ||
    typeof state.scaleName !== 'string' ||
    typeof state.scaleMode !== 'boolean'
  ) {
    Max.post('transport_state: invalid fields from lom');
    return;
  }
  broadcast({ type: 'transportState', state: state as OpenFlow.TransportState });
});

Max.addHandler('err', (reqId: number, ...rest: unknown[]) => {
  const req = pending.get(reqId);
  pending.delete(reqId);
  // Max drops an empty symbol, so the message atom may not arrive at all; and a
  // message lom failed to quote arrives split across several atoms.
  const joined = rest.map(String).join(' ').trim();
  const message = joined !== '' ? joined : 'LOM failed without a message';
  Max.post(`LOM error: ${message}`);
  const event: OpenFlow.Event = { type: 'error', id: req?.clientId, message };
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

// --- lifecycle --------------------------------------------------------

/**
 * The last resort, and not the fix.
 *
 * The maxpat runs this as `node.script bridge.js @autostart 1 @watch 1` with
 * nothing to restart it, so an uncaught throw anywhere is the show over until
 * someone reloads the device — and it is *silent*, because the Status line keeps
 * displaying the last count it was given. Staying up with one broken request is
 * strictly better than that. Every guard elsewhere in this file exists so this
 * one never fires.
 */
process.on('uncaughtException', (e) => {
  Max.post(`uncaught error — ${describe(e)} · the device is still running`);
});
process.on('unhandledRejection', (reason) => {
  Max.post(`unhandled rejection — ${describe(reason)} · the device is still running`);
});

// Both listeners are required: WebSocketServer re-emits the http server's error
// on itself, and an unhandled 'error' event takes down the whole script.
let reportedError = false;
function onServerError(e: NodeJS.ErrnoException): void {
  if (reportedError) return; // both listeners fire for the same failure
  reportedError = true;
  if (e.code === 'EADDRINUSE') {
    Max.post(
      `port ${PORT} already in use — another copy of this device is probably loaded. ` +
        `Delete the duplicate, or set OPENFLOW_PORT.`,
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
