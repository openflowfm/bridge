// lom.ts — compiled to bridge/lom.js and run by Max's [v8] object.
// Owns every LiveAPI call.
//
// This is the ONLY place that touches the Live Object Model. It speaks a
// coarse-grained message protocol to bridge.ts (Node for Max), which owns the
// WebSocket. Large payloads travel via named Max Dicts, never as message atoms
// — clip names contain spaces, commas and semicolons, all of which are special
// in Max messages.
//
// NO IMPORTS ARE POSSIBLE HERE. Compiled with `module: "none"` so that message
// handlers stay top-level globals where Max can find them. Protocol types come
// from the global BSV namespace (see protocol/global.d.ts).
//
// in:  init | hello | snapshot <reqId> | apply <reqId> <dictName> | observe <0|1>
//      palette <reqId> | ping
// out: ready | snapshot_done <reqId> <dict> <ms> | apply_progress <reqId> <n> <total>
//      apply_done <reqId> <dict> <ms> | palette_done <reqId> <dict> | changed <kind>
//      err <reqId> <msg> | pong

autowatch = 1;
inlets = 1;
outlets = 1;

const SNAPSHOT_DICT = 'bsv_snapshot';
const RESULT_DICT = 'bsv_result';
const PALETTE_DICT = 'bsv_palette';

/** LOM ops per scheduler tick — keeps Live's UI responsive. */
const CHUNK = 50;

/** Safety stop for the palette sweep; real palettes are far smaller. */
const PALETTE_MAX = 200;

interface ApplyJob {
  reqId: number;
  ops: BSV.ApplyOp[];
  i: number;
  ok: number;
  skipped: number;
  t0: number;
}

var deviceReady = false;
var helloPending = false;
/** One reusable cursor; goto() is far cheaper than constructing a LiveAPI. */
var cursorApi: LiveAPI | null = null;
var observers: LiveAPI[] = [];
var job: ApplyJob | null = null;

// --- helpers ----------------------------------------------------------

function cursor(): LiveAPI {
  if (!cursorApi) cursorApi = new LiveAPI(function () {}, 'live_set');
  return cursorApi;
}

function at(path: string): LiveAPI {
  const a = cursor();
  a.goto(path);
  return a;
}

function exists(a: LiveAPI | null): boolean {
  return !!a && !!a.id && String(a.id) !== '0';
}

function gstr(a: LiveAPI, prop: string): string {
  const v = a.get(prop);
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.length === 1 ? String(v[0]) : v.map(String).join(' ');
  return String(v);
}

function gnum(a: LiveAPI, prop: string): number {
  const v = a.get(prop);
  const x = Array.isArray(v) ? v[0] : v;
  const n = Number(x);
  return isFinite(n) ? n : 0;
}

function gbool(a: LiveAPI, prop: string): boolean {
  return gnum(a, prop) === 1;
}

/**
 * Object-list properties come back as alternating `'id', n` atoms, e.g.
 * `['id', 4, 'id', 5, ...]`. Returns just the numeric ids.
 */
function gids(a: LiveAPI, prop: string): number[] {
  const v = a.get(prop);
  const out: number[] = [];
  if (!Array.isArray(v)) return out;
  for (let i = 0; i < v.length; i++) {
    if (v[i] === 'id' && i + 1 < v.length) {
      out.push(Number(v[i + 1]));
      i++;
    }
  }
  return out;
}

/** Single-object property; 0 means "nothing there". */
function gid(a: LiveAPI, prop: string): number {
  const ids = gids(a, prop);
  return ids.length ? ids[0] : 0;
}

/**
 * Names routinely contain spaces. Unquoted they arrive at Live as a list of
 * atoms and only the first word survives.
 */
function setName(a: LiveAPI, value: unknown): void {
  const s = String(value === null || value === undefined ? '' : value);
  a.set('name', '"' + s.replace(/"/g, "'") + '"');
}

function fail(reqId: number | undefined, e: unknown): void {
  const m = String((e as Error)?.message ?? e).replace(/[",;]/g, ' ');
  post('bsv lom error: ' + m + '\n');
  outlet(0, 'err', reqId === undefined ? -1 : reqId, '"' + m + '"');
}

function publish(dictName: string, payload: unknown): void {
  const d = new Dict(dictName);
  d.clear();
  d.parse(JSON.stringify(payload));
}

// --- lifecycle --------------------------------------------------------

function init(): void {
  deviceReady = true;
  if (helloPending) {
    helloPending = false;
    hello();
  }
}

function hello(): void {
  // node.script boots slower than the device loads, but not reliably so —
  // whichever side is late drives the handshake.
  if (!deviceReady) {
    helloPending = true;
    return;
  }
  outlet(0, 'ready');
}

function ping(): void {
  outlet(0, 'pong');
}

// --- snapshot ---------------------------------------------------------

function snapshot(reqId: number): void {
  if (!deviceReady) return fail(reqId, 'device not ready');
  const t0 = Date.now();
  try {
    const set = at('live_set');
    const trackCount = set.getcount('tracks');
    const sceneCount = set.getcount('scenes');

    const tracks: BSV.Track[] = [];
    for (let t = 0; t < trackCount; t++) {
      const a = at('live_set tracks ' + t);
      tracks.push({
        i: t,
        name: gstr(a, 'name'),
        color: gnum(a, 'color'),
        colorIndex: gnum(a, 'color_index'),
        isMidi: gbool(a, 'has_midi_input'),
        isGroup: gbool(a, 'is_foldable'),
        isGrouped: gbool(a, 'is_grouped'),
      });
    }

    const tTracks = Date.now();

    const scenes: BSV.Scene[] = [];
    for (let s = 0; s < sceneCount; s++) {
      const a = at('live_set scenes ' + s);
      scenes.push({
        i: s,
        name: gstr(a, 'name'),
        color: gnum(a, 'color'),
        colorIndex: gnum(a, 'color_index'),
        isEmpty: gbool(a, 'is_empty'),
        tempo: gnum(a, 'tempo'),
      });
    }

    const tScenes = Date.now();

    // Two passes on purpose. The occupancy scan is trackCount × sceneCount and
    // is mostly empty slots, while the property reads only touch clips that
    // exist — timing them separately is what tells us which one to attack.
    //
    // The scan addresses slots by id rather than by path string: resolving
    // 'live_set tracks 3 clip_slots 412' means parsing and walking that path
    // every time, whereas one get('clip_slots') per track hands back every id
    // up front and 'id N' resolves directly. Reading `clip` then answers
    // occupancy AND yields the clip's id, replacing a has_clip probe plus a
    // second (longer) path resolution for the clip itself.
    const occupied: Array<[number, number, number]> = []; // track, scene, clipId
    let slotsScanned = 0;
    for (let t = 0; t < trackCount; t++) {
      if (tracks[t].isGroup) continue; // group tracks have no real clip slots

      let slotIds = gids(at('live_set tracks ' + t), 'clip_slots');
      if (slotIds.length === 0 && sceneCount > 0) {
        // Belt and braces: if the id list ever comes back in a shape we don't
        // recognise, fall back to path addressing rather than silently
        // reporting an empty track.
        for (let s = 0; s < sceneCount; s++) {
          slotsScanned++;
          const slot = at('live_set tracks ' + t + ' clip_slots ' + s);
          if (!exists(slot) || !gbool(slot, 'has_clip')) continue;
          const c = at('live_set tracks ' + t + ' clip_slots ' + s + ' clip');
          if (exists(c)) occupied.push([t, s, Number(c.id)]);
        }
        continue;
      }

      for (let s = 0; s < slotIds.length; s++) {
        slotsScanned++;
        const clipId = gid(at('id ' + slotIds[s]), 'clip');
        if (clipId) occupied.push([t, s, clipId]);
      }
    }
    const tSlots = Date.now();

    const clips: BSV.Clip[] = [];
    for (let i = 0; i < occupied.length; i++) {
      const t = occupied[i][0];
      const s = occupied[i][1];
      const c = at('id ' + occupied[i][2]);
      if (!exists(c)) continue;
      clips.push({
        t: t,
        s: s,
        name: gstr(c, 'name'),
        colorIndex: gnum(c, 'color_index'),
        color: gnum(c, 'color'),
        length: gnum(c, 'length'),
        isMidi: gbool(c, 'is_midi_clip'),
      });
    }
    const tClips = Date.now();

    const ms = tClips - t0;
    const payload: BSV.Snapshot = {
      rev: Date.now(),
      ms: ms,
      timings: {
        tracks: tTracks - t0,
        scenes: tScenes - tTracks,
        slots: tSlots - tScenes,
        clips: tClips - tSlots,
        slotsScanned: slotsScanned,
      },
      tempo: gnum(at('live_set'), 'tempo'),
      trackCount: trackCount,
      sceneCount: sceneCount,
      clipCount: clips.length,
      tracks: tracks,
      scenes: scenes,
      clips: clips,
    };

    const tDict = Date.now();
    publish(SNAPSHOT_DICT, payload);
    outlet(0, 'snapshot_done', reqId, SNAPSHOT_DICT, Date.now() - tDict);
  } catch (e) {
    fail(reqId, e);
  }
}

// --- apply ------------------------------------------------------------
// ops: [{ t, s, name?, colorIndex? }] — clip-slot addressed, one property write
// each. Executed in chunks off the main message so Live's UI keeps breathing.

function apply(reqId: number, dictName: string): void {
  if (!deviceReady) return fail(reqId, 'device not ready');
  if (job) return fail(reqId, 'apply already in progress');
  try {
    const d = new Dict(dictName);
    const ops: BSV.ApplyOp[] = JSON.parse(d.stringify()).ops || [];
    job = { reqId: reqId, ops: ops, i: 0, ok: 0, skipped: 0, t0: Date.now() };
    if (!ops.length) return finishJob();
    applyTask.repeat();
  } catch (e) {
    job = null;
    fail(reqId, e);
  }
}

function execOp(op: BSV.ApplyOp): void {
  const j = job!;
  const c = at('live_set tracks ' + op.t + ' clip_slots ' + op.s + ' clip');
  if (!exists(c)) {
    j.skipped++;
    return;
  }
  if (op.name !== undefined) setName(c, op.name);
  if (op.colorIndex !== undefined) c.set('color_index', op.colorIndex);
  j.ok++;
}

function applyStep(): void {
  const j = job;
  if (!j) {
    applyTask.cancel();
    return;
  }
  const end = Math.min(j.i + CHUNK, j.ops.length);
  for (; j.i < end; j.i++) {
    try {
      execOp(j.ops[j.i]);
    } catch (e) {
      j.skipped++;
    }
  }
  outlet(0, 'apply_progress', j.reqId, j.i, j.ops.length);
  if (j.i >= j.ops.length) {
    applyTask.cancel();
    finishJob();
  }
}

function finishJob(): void {
  const j = job!;
  const ms = Date.now() - j.t0;
  const result: BSV.ApplyResult = { applied: j.ok, skipped: j.skipped, total: j.ops.length };
  job = null;
  publish(RESULT_DICT, result);
  outlet(0, 'apply_done', j.reqId, RESULT_DICT, ms);
}

var applyTask = new Task(applyStep);
applyTask.interval = 2;

// --- palette ----------------------------------------------------------
// Live exposes no way to read its color palette, so derive it: append a scratch
// scene, walk color_index upward reading back the RGB Live assigns, then delete
// the scene. Nothing the user owns is touched, and the sweep stops as soon as
// Live clamps the index — that's how we learn the palette size rather than
// assuming it.

function palette(reqId: number): void {
  if (!deviceReady) return fail(reqId, 'device not ready');
  let scratchIndex = -1;
  const set = new LiveAPI(function () {}, 'live_set');
  try {
    const before = set.getcount('scenes');
    set.call('create_scene', -1);
    if (set.getcount('scenes') !== before + 1) throw new Error('could not create scratch scene');
    scratchIndex = before;

    const sc = new LiveAPI(function () {}, 'live_set scenes ' + scratchIndex);
    const colors: number[] = [];
    for (let i = 0; i < PALETTE_MAX; i++) {
      sc.set('color_index', i);
      if (gnum(sc, 'color_index') !== i) break; // clamped — past the end
      colors.push(gnum(sc, 'color') & 0xffffff);
    }

    const p: BSV.Palette = { count: colors.length, colors: colors };
    publish(PALETTE_DICT, p);
    outlet(0, 'palette_done', reqId, PALETTE_DICT);
  } catch (e) {
    fail(reqId, e);
  } finally {
    if (scratchIndex >= 0) {
      try {
        set.call('delete_scene', scratchIndex);
      } catch (e) {
        post('bsv: FAILED to remove scratch scene at index ' + scratchIndex + '\n');
      }
    }
  }
}

// --- observers --------------------------------------------------------
// MVP watches structure only (track/scene lists). Per-clip observers would be
// ~1 per slot; measure the snapshot cost before deciding that's worth it.

function onStructureChange(): void {
  outlet(0, 'changed', 'structure');
}

function observe(on: number): void {
  clearObservers();
  if (Number(on) !== 1) return;
  try {
    const tracksObs = new LiveAPI(onStructureChange, 'live_set');
    tracksObs.property = 'tracks';
    const scenesObs = new LiveAPI(onStructureChange, 'live_set');
    scenesObs.property = 'scenes';
    observers = [tracksObs, scenesObs];
  } catch (e) {
    fail(-1, e);
  }
}

function clearObservers(): void {
  for (let i = 0; i < observers.length; i++) {
    try {
      observers[i].property = '';
    } catch (e) {
      /* object may already be gone */
    }
  }
  observers = [];
}

function anything(): void {
  post('bsv lom: unhandled message "' + messagename + '"\n');
}

function notifydeleted(): void {
  clearObservers();
  applyTask.cancel();
}
