// lom.js — runs in Max's [v8] object. Owns every LiveAPI call.
//
// This is the ONLY place that touches the Live Object Model. It speaks a
// coarse-grained message protocol to bridge.js (Node for Max), which owns the
// WebSocket. Large payloads travel via named Max Dicts, never as message atoms
// — clip names contain spaces, commas and semicolons, all of which are special
// in Max messages.
//
// in:  init | hello | snapshot <reqId> | apply <reqId> <dictName> | observe <0|1>
//      palette <reqId>
// out: ready | snapshot_done <reqId> <dict> <ms> | apply_progress <reqId> <n> <total>
//      apply_done <reqId> <dict> <ms> | palette_done <reqId> <dict> | changed <kind>
//      err <reqId> <msg>

autowatch = 1;
inlets = 1;
outlets = 1;

const SNAPSHOT_DICT = 'bsv_snapshot';
const RESULT_DICT = 'bsv_result';
const CHUNK = 50; // LOM ops per scheduler tick — keeps Live's UI responsive

var deviceReady = false;
var helloPending = false;
var api = null; // one reusable LiveAPI cursor; goto() is far cheaper than new
var observers = [];
var job = null;

// --- helpers ----------------------------------------------------------

function cursor() {
  if (!api) api = new LiveAPI(function () {}, 'live_set');
  return api;
}

function at(path) {
  const a = cursor();
  a.goto(path);
  return a;
}

function exists(a) {
  return a && a.id && String(a.id) !== '0';
}

function gstr(a, prop) {
  const v = a.get(prop);
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.length === 1 ? String(v[0]) : v.map(String).join(' ');
  return String(v);
}

function gnum(a, prop) {
  const v = a.get(prop);
  const x = Array.isArray(v) ? v[0] : v;
  const nn = Number(x);
  return isFinite(nn) ? nn : 0;
}

// Names routinely contain spaces. Unquoted they arrive at Live as a list of
// atoms and only the first word survives.
function setName(a, value) {
  const s = String(value === null || value === undefined ? '' : value);
  a.set('name', '"' + s.replace(/"/g, "'") + '"');
}

function fail(reqId, e) {
  const m = String((e && e.message) || e).replace(/[",;]/g, ' ');
  post('bsv lom error: ' + m + '\n');
  outlet(0, 'err', reqId === undefined ? -1 : reqId, '"' + m + '"');
}

// --- lifecycle --------------------------------------------------------

function init() {
  deviceReady = true;
  if (helloPending) {
    helloPending = false;
    hello();
  }
}

function hello() {
  // node.script boots slower than the device loads, but not reliably so —
  // whichever side is late drives the handshake.
  if (!deviceReady) {
    helloPending = true;
    return;
  }
  outlet(0, 'ready');
}

function ping() {
  outlet(0, 'pong');
}

// --- snapshot ---------------------------------------------------------

function snapshot(reqId) {
  if (!deviceReady) return fail(reqId, 'device not ready');
  const t0 = Date.now();
  try {
    const set = at('live_set');
    const trackCount = set.getcount('tracks');
    const sceneCount = set.getcount('scenes');

    const tracks = [];
    for (let t = 0; t < trackCount; t++) {
      const a = at('live_set tracks ' + t);
      tracks.push({
        i: t,
        name: gstr(a, 'name'),
        color: gnum(a, 'color'),
        isMidi: gnum(a, 'has_midi_input') === 1,
        isGroup: gnum(a, 'is_foldable') === 1,
        isGrouped: gnum(a, 'is_grouped') === 1,
      });
    }

    const scenes = [];
    for (let s = 0; s < sceneCount; s++) {
      const a = at('live_set scenes ' + s);
      scenes.push({
        i: s,
        name: gstr(a, 'name'),
        color: gnum(a, 'color'),
        isEmpty: gnum(a, 'is_empty') === 1,
        tempo: gnum(a, 'tempo'),
      });
    }

    const clips = [];
    for (let t = 0; t < trackCount; t++) {
      if (tracks[t].isGroup) continue; // group tracks have no real clip slots
      for (let s = 0; s < sceneCount; s++) {
        const slot = at('live_set tracks ' + t + ' clip_slots ' + s);
        if (!exists(slot) || gnum(slot, 'has_clip') !== 1) continue;
        const c = at('live_set tracks ' + t + ' clip_slots ' + s + ' clip');
        if (!exists(c)) continue;
        clips.push({
          t: t,
          s: s,
          name: gstr(c, 'name'),
          // colorIndex is what we write; color is Live's exact RGB for that
          // index, so the UI never has to look anything up to render.
          colorIndex: gnum(c, 'color_index'),
          color: gnum(c, 'color'),
          length: gnum(c, 'length'),
          isMidi: gnum(c, 'is_midi_clip') === 1,
        });
      }
    }

    const ms = Date.now() - t0;
    const payload = {
      rev: Date.now(),
      ms: ms,
      tempo: gnum(at('live_set'), 'tempo'),
      trackCount: trackCount,
      sceneCount: sceneCount,
      clipCount: clips.length,
      tracks: tracks,
      scenes: scenes,
      clips: clips,
    };

    const d = new Dict(SNAPSHOT_DICT);
    d.clear();
    d.parse(JSON.stringify(payload));
    outlet(0, 'snapshot_done', reqId, SNAPSHOT_DICT, ms);
  } catch (e) {
    fail(reqId, e);
  }
}

// --- apply ------------------------------------------------------------
// ops: [{ t, s, name?, colorIndex? }] — clip-slot addressed, one property write
// each. Executed in chunks off the main message so Live's UI keeps breathing.

function apply(reqId, dictName) {
  if (!deviceReady) return fail(reqId, 'device not ready');
  if (job) return fail(reqId, 'apply already in progress');
  try {
    const d = new Dict(dictName);
    const ops = JSON.parse(d.stringify()).ops || [];
    job = { reqId: reqId, ops: ops, i: 0, ok: 0, skipped: 0, t0: Date.now() };
    if (!ops.length) return finishJob();
    applyTask.repeat();
  } catch (e) {
    job = null;
    fail(reqId, e);
  }
}

function execOp(op) {
  const c = at('live_set tracks ' + op.t + ' clip_slots ' + op.s + ' clip');
  if (!exists(c)) {
    job.skipped++;
    return;
  }
  if (op.name !== undefined) setName(c, op.name);
  if (op.colorIndex !== undefined) c.set('color_index', op.colorIndex);
  else if (op.color !== undefined) c.set('color', op.color);
  job.ok++;
}

function applyStep() {
  if (!job) {
    applyTask.cancel();
    return;
  }
  const end = Math.min(job.i + CHUNK, job.ops.length);
  for (; job.i < end; job.i++) {
    try {
      execOp(job.ops[job.i]);
    } catch (e) {
      job.skipped++;
    }
  }
  outlet(0, 'apply_progress', job.reqId, job.i, job.ops.length);
  if (job.i >= job.ops.length) {
    applyTask.cancel();
    finishJob();
  }
}

function finishJob() {
  const ms = Date.now() - job.t0;
  const d = new Dict(RESULT_DICT);
  d.clear();
  d.parse(JSON.stringify({ applied: job.ok, skipped: job.skipped, total: job.ops.length }));
  const reqId = job.reqId;
  job = null;
  outlet(0, 'apply_done', reqId, RESULT_DICT, ms);
}

var applyTask = new Task(applyStep);
applyTask.interval = 2;

// --- palette ----------------------------------------------------------
// Live exposes no way to read its color palette, so derive it: append a scratch
// scene, walk color_index upward reading back the RGB Live assigns, then delete
// the scene. Nothing the user owns is touched, and the sweep stops as soon as
// Live clamps the index — that's how we learn the palette size rather than
// assuming it.

const PALETTE_MAX = 200; // safety stop; real palettes are far smaller

function palette(reqId) {
  if (!deviceReady) return fail(reqId, 'device not ready');
  let scratchIndex = -1;
  const set = new LiveAPI(function () {}, 'live_set');
  try {
    const before = set.getcount('scenes');
    set.call('create_scene', -1);
    if (set.getcount('scenes') !== before + 1) throw new Error('could not create scratch scene');
    scratchIndex = before;

    const sc = new LiveAPI(function () {}, 'live_set scenes ' + scratchIndex);
    const colors = [];
    for (let i = 0; i < PALETTE_MAX; i++) {
      sc.set('color_index', i);
      if (gnum(sc, 'color_index') !== i) break; // clamped — past the end
      colors.push(gnum(sc, 'color') & 0xffffff);
    }

    const d = new Dict('bsv_palette');
    d.clear();
    d.parse(JSON.stringify({ count: colors.length, colors: colors }));
    outlet(0, 'palette_done', reqId, 'bsv_palette');
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

function onStructureChange() {
  outlet(0, 'changed', 'structure');
}

function observe(on) {
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

function clearObservers() {
  for (let i = 0; i < observers.length; i++) {
    try {
      observers[i].property = '';
    } catch (e) {}
  }
  observers = [];
}

function anything() {
  post('bsv lom: unhandled message "' + messagename + '"\n');
}

function notifydeleted() {
  clearObservers();
  applyTask.cancel();
}
