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
//      add_scenes <reqId> <dictName>
//      move <reqId> <dictName> | palette <reqId> (developer diagnostic only)
//      diag <what> [arg] (developer diagnostic only; answers in the Max window)
//      playback <verb> <i> <j>
//      set_fold <track> <0|1> | watch_play <0|1> | watch_meters <0|1>
//      watch_selection <0|1> | ping | set_info
// out: ready | snapshot_progress <reqId> <n> <total>
//      snapshot_done <reqId> <dict> <ms> | apply_progress <reqId> <n> <total>
//      apply_done <reqId> <dict> <ms> | add_scenes_done <reqId> <dict> <ms>
//      move_progress <reqId> <n> <total>
//      move_done <reqId> <dict> <ms> | move_clips_done <reqId> <dict> <ms>
//      palette_done <reqId> <dict> | changed <kind> | delta <dict>
//      set_info_done <dict>
//      play_state <isPlaying> <t0 playing> <t0 fired> <t1 playing> … | err <reqId> <msg>
//      song_position <bar> <beat> <sixteenth>
//      meter_levels <track0> <level0> <track1> <level1> …
//      pong

autowatch = 1;
inlets = 1;
outlets = 1;

const SNAPSHOT_DICT = 'bsv_snapshot';
const RESULT_DICT = 'bsv_result';
const PALETTE_DICT = 'bsv_palette';
const SET_DICT = 'bsv_set';
/** Partial re-reads pushed when the user changes something in Live. */
const DELTA_DICT = 'bsv_delta';
/** node → lom. The only dict we don't create by publishing to it — see ensureDicts. */
const OPS_DICT = 'bsv_ops';

/** LOM ops per scheduler tick — keeps Live's UI responsive. */
const CHUNK = 50;

/** Safety stop for the palette sweep; real palettes are far smaller. */
const PALETTE_MAX = 200;

/**
 * Runaway guard for `diag attach`. A full-size set is ~4,400 slots, so this
 * leaves room to go past one and still not wedge Live on a typo.
 */
const DIAG_ATTACH_MAX = 8000;

interface ApplyJob {
  reqId: number;
  ops: BSV.ApplyOp[];
  /**
   * Scene writes, run after the clip writes in the same chunked job. One job
   * rather than two keeps `applied + skipped` a count of the whole batch, so a
   * write that tags scenes and recolors their clips reports one honest total.
   */
  sceneOps: BSV.SceneOp[];
  /** Position across `ops` then `sceneOps`, i.e. `0 .. ops.length + sceneOps.length`. */
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
var playObservers: LiveAPI[] = [];
var meterObservers: LiveAPI[] = [];
/** A burst of play-state callbacks is pending a single coalesced report. */
var playDirty = false;
/** Song time has changed and a position report is pending. */
var positionDirty = false;
/** Last displayed position, so sub-sixteenth callbacks stay local. */
var lastPositionKey = '';
/** Last value seen per track, used to suppress duplicate callbacks. */
var meterLevels: number[] = [];
/** Latest momentary channel values; combined into meterLevels with max(L, R). */
var meterLeft: number[] = [];
var meterRight: number[] = [];
var metersWatching = false;
var job: ApplyJob | null = null;
/** Suppress the per-scene observer burst while add_scenes emits one terminal structural event. */
var addingScenes = false;

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
 * Numeric property Live is allowed to answer with nothing. A scene's
 * `color_index` is documented as "Can be None for no color", and gnum would
 * report that as palette slot 0 — a real color.
 *
 * Mirrored as `parseNumOr` in core/src/lomAtoms.ts, where it has tests.
 */
function gnumOr(a: LiveAPI, prop: string, fallback: number): number {
  const v = a.get(prop);
  const x = Array.isArray(v) ? (v.length ? v[0] : undefined) : v;
  if (x === undefined || x === null || x === '') return fallback;
  const n = Number(x);
  return isFinite(n) ? n : fallback;
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
 * Single-object property, keeping "empty" and "unreadable" apart.
 *
 * `gid` answers 0 both for a clip slot that is genuinely empty and for a cursor
 * that never resolved, and that collapse is exactly how a set full of clips
 * once reported zero of them. Returns the id, `0` for a slot that resolved and
 * holds nothing, or `-1` when the reply wasn't an `['id', n]` pair at all.
 *
 * Mirrored as `parseObjectRef` in core/src/lomAtoms.ts, where it has tests.
 */
function gref(a: LiveAPI, prop: string): number {
  const v = a.get(prop);
  if (!Array.isArray(v) || v.length < 2 || v[0] !== 'id') return -1;
  const n = Number(v[1]);
  return isFinite(n) ? n : -1;
}

/**
 * Which form of name write this Max build actually wants.
 *
 * `null` until a multi-word name has settled it. Only a name with a space can
 * settle it — a single word round-trips identically either way, so probing on
 * one would decide nothing and cache the wrong answer.
 */
var quoteNames: boolean | null = null;

function quoted(s: string): string {
  return '"' + s.replace(/"/g, "'") + '"';
}

/**
 * Set a `name` property, and get the spaces right.
 *
 * This wrapper exists because the two plausible ways to write a multi-word name
 * fail in opposite directions and **the failure is invisible from here**: quote
 * a name a build doesn't want quoted and Live stores the quotes as part of the
 * name; don't quote one that needs it and Live takes the first word and drops
 * the rest. Both `set` calls succeed. Nothing throws.
 *
 * So it isn't guessed at — it's measured, once. The first multi-word name is
 * written plain, read back, and compared; if it didn't survive, the quoted form
 * is written instead and the answer is cached for the session. One extra `get`
 * per Live session, and after that every write takes the settled path.
 *
 * `[js]` lore says quote it, and this file did until a real set showed scene
 * names coming back with literal quotes around them — so under `v8` a JS string
 * is evidently passed as one symbol and needs no help. That's now the form
 * tried first rather than the form assumed, because it's the one that keeps a
 * name Live can't parse out of the set.
 */
function setName(a: LiveAPI, value: unknown): void {
  const s = String(value === null || value === undefined ? '' : value);

  if (quoteNames !== null) {
    a.set('name', quoteNames ? quoted(s) : s);
    return;
  }

  a.set('name', s);
  if (s.indexOf(' ') < 0) return; // settles nothing — try again on the next one

  const back = gstr(a, 'name');
  if (back === s) {
    quoteNames = false;
    return;
  }

  a.set('name', quoted(s));
  const backQuoted = gstr(a, 'name');
  quoteNames = backQuoted === s;
  if (!quoteNames) {
    // Neither form round-tripped. Stay on the plain one and say so loudly: a
    // truncated name is at least obviously wrong, where a name carrying stray
    // punctuation reads as very nearly right and gets written 848 times.
    a.set('name', s);
    post(
      'bsv setName: neither form round-trips. Sent "' + s + '", plain read back "' +
        back + '", quoted read back "' + backQuoted + '". Staying plain.\n',
    );
  }
}

/**
 * `||`, not `??`: an Error carrying an empty message is exactly as untraceable
 * as one carrying none, and `??` lets `''` straight through. An error that
 * reaches the UI as "color: " tells the user nothing and tells us less.
 */
function describe(e: unknown): string {
  const m = (e as Error)?.message;
  if (typeof m === 'string' && m !== '') return m;
  const s = String(e);
  if (s && s !== 'undefined' && s !== 'null' && s !== '[object Object]') return s;
  return 'unknown error in lom.js — see the Max window';
}

function fail(reqId: number | undefined, e: unknown): void {
  const m = describe(e).replace(/[",;]/g, ' ');
  post('bsv lom error: ' + m + '\n');
  outlet(0, 'err', reqId === undefined ? -1 : reqId, '"' + m + '"');
}

function publish(dictName: string, payload: unknown): void {
  const d = new Dict(dictName);
  d.clear();
  d.parse(JSON.stringify(payload));
}

// --- lifecycle --------------------------------------------------------

/**
 * Named dicts we hold open for the life of the device.
 *
 * `Max.setDict` on the Node side can only write a dict that ALREADY EXISTS in
 * Max — max-api says so in its own error text ("Please make sure the requested
 * dict exists") — and Max rejects a missing one with an empty message, which
 * arrives in the UI as the uninformative "apply: Error".
 *
 * The three lom → node dicts create themselves: `publish()` calls
 * `new Dict(name)` before anything reads them. `bsv_ops` travels the other way,
 * so nothing ever created it, and staging an op batch could never work. Creating
 * it here is the fix.
 *
 * The references are kept because a Max dict is reference-counted; letting the
 * wrapper be collected can take the dict with it.
 */
var heldDicts: Dict[] = [];

function ensureDicts(): void {
  const names = [SNAPSHOT_DICT, RESULT_DICT, PALETTE_DICT, SET_DICT, DELTA_DICT, OPS_DICT];
  heldDicts = [];
  for (let i = 0; i < names.length; i++) {
    try {
      heldDicts.push(new Dict(names[i]));
    } catch (e) {
      post('bsv: could not create dict ' + names[i] + ' — ' + describe(e) + '\n');
    }
  }
}

function init(): void {
  deviceReady = true;
  ensureDicts();
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

/**
 * Where the open Live Set lives on disk, so the bridge can keep that set's role
 * vocabulary beside it instead of in one pile per machine.
 *
 * **`file_path` is get-only — there is no observer for it.** Verified in both
 * sources: the property table lists `get` alone where its neighbours say
 * `get, observe`, and Live 12.4.3's own docstring ("Get the current Live Set's
 * path on disk.") sits in the Song block with no listener counterpart. So
 * nothing can tell us the user picked Save As; the bridge re-asks after every
 * snapshot, which is the moment it re-syncs anyway.
 *
 * **Empty is a normal answer, not a failure.** A set that has never been saved
 * has no path and no name — the docs say so and the binary agrees — and the
 * bridge falls back to its machine-wide file rather than treating it as broken.
 *
 * Travels by Dict because a path contains spaces and Max atoms are space
 * separated; see the note on `gstr` in `bridge/README.md`.
 */
function set_info(): void {
  try {
    const s = at('live_set');
    publish(SET_DICT, { filePath: gstr(s, 'file_path'), name: gstr(s, 'name') });
    outlet(0, 'set_info_done', SET_DICT);
  } catch (e) {
    fail(undefined, e);
  }
}

// --- snapshot ---------------------------------------------------------

function snapshot(reqId: number): void {
  if (!deviceReady) return fail(reqId, 'device not ready');
  const t0 = Date.now();
  // The four phases do very different amounts of work, so raw item counts
  // would make the bar jump backwards when the next phase's total becomes
  // known. Give each phase a stable slice instead. Integer de-duplication also
  // caps a large set at 101 messages rather than sending one per scene/clip.
  let lastProgress = -1;
  function progress(done: number): void {
    const next = Math.max(0, Math.min(100, Math.floor(done)));
    if (next === lastProgress) return;
    lastProgress = next;
    outlet(0, 'snapshot_progress', reqId, next, 100);
  }
  function phase(start: number, span: number, done: number, total: number): void {
    progress(total > 0 ? start + span * done / total : start + span);
  }
  try {
    progress(0);
    const set = at('live_set');
    const trackCount = set.getcount('tracks');
    const sceneCount = set.getcount('scenes');

    // group_track hands back the parent's LOM id, but everything downstream
    // addresses tracks by index, so keep an id -> index map to resolve them.
    // A second pass is needed regardless: a nested group's parent is itself a
    // track, and only after the walk are all ids known.
    const tracks: BSV.Track[] = [];
    const indexOfId: { [id: string]: number } = {};
    const parentIds: number[] = [];
    for (let t = 0; t < trackCount; t++) {
      const a = at('live_set tracks ' + t);
      const isGroup = gbool(a, 'is_foldable');
      indexOfId[String(a.id)] = t;
      parentIds.push(gbool(a, 'is_grouped') ? gid(a, 'group_track') : 0);
      tracks.push({
        i: t,
        name: gstr(a, 'name'),
        color: gnum(a, 'color'),
        colorIndex: gnum(a, 'color_index'),
        isMidi: gbool(a, 'has_midi_input'),
        isGroup: isGroup,
        isGrouped: gbool(a, 'is_grouped'),
        groupIndex: -1, // resolved below
        // fold_state is documented as only available when is_foldable, so
        // don't ask for it on a track that isn't a group.
        isFolded: isGroup ? gbool(a, 'fold_state') : false,
      });
      phase(0, 10, t + 1, trackCount);
    }
    for (let t = 0; t < trackCount; t++) {
      if (!parentIds[t]) continue;
      const parent = indexOfId[String(parentIds[t])];
      if (parent !== undefined) tracks[t].groupIndex = parent;
    }

    const tTracks = Date.now();

    const scenes: BSV.Scene[] = [];
    for (let s = 0; s < sceneCount; s++) {
      const a = at('live_set scenes ' + s);
      scenes.push({
        i: s,
        name: gstr(a, 'name'),
        color: gnum(a, 'color'),
        // -1 when the scene has no color; slot 0 is a real color.
        colorIndex: gnumOr(a, 'color_index', -1),
        isEmpty: gbool(a, 'is_empty'),
        tempo: gnum(a, 'tempo'),
      });
      phase(10, 10, s + 1, sceneCount);
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
    let tracksViaPath = 0;
    let probe = '';
    const slotTrackCount = tracks.reduce((n, track) => n + (track.isGroup ? 0 : 1), 0);
    let slotTracksDone = 0;
    for (let t = 0; t < trackCount; t++) {
      if (tracks[t].isGroup) continue; // group tracks have no real clip slots

      const slotIds = gids(at('live_set tracks ' + t), 'clip_slots');

      // The fast path. Its correctness rests on two things we cannot check
      // without Live open — that 'id N' resolves through goto(), and that a
      // clip slot answers get('clip') as an ['id', n] pair — and when either
      // is wrong EVERY slot reads as empty rather than erroring. So the
      // fallback can't key off the id list being empty (it isn't); it has to
      // key off the scan failing to read, which is what gref reports.
      let usedIds = false;
      if (slotIds.length > 0) {
        const found: Array<[number, number, number]> = [];
        usedIds = true;
        for (let s = 0; s < slotIds.length; s++) {
          const clipId = gref(at('id ' + slotIds[s]), 'clip');
          if (clipId < 0) {
            // Nothing this pass produced for this track is trustworthy.
            if (!probe) {
              probe =
                'track ' + t + ' slot id ' + slotIds[s] + ' clip atoms: ' +
                JSON.stringify(at('id ' + slotIds[s]).get('clip'));
            }
            usedIds = false;
            break;
          }
          if (clipId > 0) found.push([t, s, clipId]);
        }
        if (usedIds) {
          slotsScanned += slotIds.length;
          for (let i = 0; i < found.length; i++) occupied.push(found[i]);
        }
      }
      if (usedIds) {
        slotTracksDone++;
        phase(20, 60, slotTracksDone, slotTrackCount);
        continue;
      }

      // Path addressing plus has_clip. Slower, and the whole reason the id
      // scan exists — but it's the one this project has actually watched work
      // against a real set, so it's what we fall back to.
      tracksViaPath++;
      for (let s = 0; s < sceneCount; s++) {
        slotsScanned++;
        const slot = at('live_set tracks ' + t + ' clip_slots ' + s);
        if (!exists(slot) || !gbool(slot, 'has_clip')) continue;
        const c = at('live_set tracks ' + t + ' clip_slots ' + s + ' clip');
        if (exists(c)) occupied.push([t, s, Number(c.id)]);
      }
      slotTracksDone++;
      phase(20, 60, slotTracksDone, slotTrackCount);
    }
    phase(20, 60, slotTrackCount, slotTrackCount);
    const tSlots = Date.now();

    if (tracksViaPath > 0) {
      // Visible, not silent: the snapshot is correct but the fast path is off.
      // The atom dump is what tells us which assumption is wrong.
      post(
        'bsv: id-addressed slot scan did not resolve — ' + tracksViaPath +
          ' track(s) rescanned by path. ' + probe + '\n',
      );
    }

    const clips: BSV.Clip[] = [];
    for (let i = 0; i < occupied.length; i++) {
      const t = occupied[i][0];
      const s = occupied[i][1];
      // Same 'id N' dependency as the scan above, so the same self-healing:
      // if the id doesn't resolve, reach the clip by the path we know works.
      let c = at('id ' + occupied[i][2]);
      if (!exists(c)) c = at('live_set tracks ' + t + ' clip_slots ' + s + ' clip');
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
      phase(80, 18, i + 1, occupied.length);
    }
    phase(80, 18, occupied.length, occupied.length);
    const tClips = Date.now();

    const ms = tClips - t0;
    const payload: BSV.Snapshot = {
      // Shares the sequence with deltas, so a client can tell a delta that
      // follows what it holds from one that skipped a step.
      rev: nextRev(),
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
    progress(99);
    publish(SNAPSHOT_DICT, payload);
    progress(100);
    outlet(0, 'snapshot_done', reqId, SNAPSHOT_DICT, Date.now() - tDict);
  } catch (e) {
    fail(reqId, e);
  }
}

// --- apply ------------------------------------------------------------
// ops:      [{ t, s, name?, colorIndex? }]        — clip-slot addressed
// sceneOps: [{ s, name?, colorIndex?, color? }]   — scene addressed
//
// One property write each, executed in chunks off the main message so Live's UI
// keeps breathing. Clips first, then scenes, in one job.

/**
 * A Max dict collapses a ONE-ELEMENT array into the element itself, so a
 * single-item write arrives as an object rather than a list. Left alone,
 * `.length` is undefined, the batch looks empty, and the write reports
 * "0 applied" while doing nothing — silent, and indistinguishable from a
 * selection that had nothing to change.
 */
function asList<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === 'object') return [v as T];
  return [];
}

function apply(reqId: number, dictName: string): void {
  if (!deviceReady) return fail(reqId, 'device not ready');
  if (job || moveJob || clipJob) return fail(reqId, 'a write is already in progress');
  try {
    const d = new Dict(dictName);
    const raw = d.stringify();
    let parsed: { ops?: unknown; sceneOps?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Say what it actually was. A parse failure with no payload in the message
      // is the kind of error that costs an hour.
      throw new Error(
        'could not parse ' + dictName + ' as JSON: ' + String(raw).substring(0, 200),
      );
    }

    const ops = asList<BSV.ApplyOp>(parsed.ops);
    const sceneOps = asList<BSV.SceneOp>(parsed.sceneOps);
    const total = ops.length + sceneOps.length;

    if (!total) {
      post(
        'bsv apply: no ops found in ' + dictName + ' — dict contained: ' +
          String(raw).substring(0, 300) + '\n',
      );
    }
    job = {
      reqId: reqId,
      ops: ops,
      sceneOps: sceneOps,
      i: 0,
      ok: 0,
      skipped: 0,
      t0: Date.now(),
    };
    if (!total) return finishJob();
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

/**
 * A scene write.
 *
 * **Color goes in as RGB, never as `color_index`.** `Scene.color_index` is
 * documented "Can be None for no color", and Max's LiveAPI can read an
 * `Optional[int]` but cannot construct one to write — Live answers
 * `v8liveapi: set: unsupported property type` and the write silently does
 * nothing. Both classes document plain `color` as "Get/set access to the color
 * of the … (RGB)" with no None, so that is the writable form. This is the
 * documented exception to the project's "colors are indexes" rule and it exists
 * only for scenes and tracks; `execOp` above still writes clips by index.
 *
 * `colorIndex` rides along on the op for the UI's and undo's benefit and is
 * deliberately not written here.
 */
function execSceneOp(op: BSV.SceneOp): void {
  const j = job!;
  const a = at('live_set scenes ' + op.s);
  if (!exists(a)) {
    j.skipped++;
    return;
  }
  if (op.name !== undefined) setName(a, op.name);
  if (op.color !== undefined) a.set('color', op.color);
  if (op.tempo !== undefined) setSceneTempo(a, op.tempo);
  j.ok++;
}

/** Live's own bound, from an assertion in the 12.4.3 binary. Mirrors core. */
var MIN_TEMPO = 20;

/**
 * A scene's own tempo, which is a playback change rather than a naming one:
 * "the song will use the scene's tempo as soon as the scene is fired".
 *
 * **Order matters and is the whole reason this isn't one `set`.**
 * `tempo_enabled` gates the property — with it off, `Scene.tempo` reads back
 * -1 whatever you wrote — so enabling has to come first or the write lands on
 * a disabled scene and disappears. Disabling goes the other way round: there's
 * no point writing a value we're about to switch off.
 *
 * Below `MIN_TEMPO` means disable, matching how Live reports it.
 */
function setSceneTempo(a: LiveAPI, tempo: number): void {
  if (tempo < MIN_TEMPO) {
    a.set('tempo_enabled', 0);
    return;
  }
  a.set('tempo_enabled', 1);
  a.set('tempo', tempo);
}

/**
 * Insert a run of blank scenes and configure them as one song.
 *
 * This is intentionally not a degenerate scene move. A move's final pass
 * deletes scenes; an additive feature should be structurally incapable of
 * reaching that code, not merely promise to send an empty remove list.
 *
 * Eight scenes are small enough to do synchronously, and configuring each one
 * immediately after creation means a failure leaves a plainly visible partial
 * block rather than eight anonymous rows whose intended metadata is lost.
 */
function add_scenes(reqId: number, dictName: string): void {
  if (!deviceReady) return fail(reqId, 'device not ready');
  if (job || moveJob || clipJob) return fail(reqId, 'a write is already in progress');
  const t0 = Date.now();
  try {
    const d = new Dict(dictName);
    const raw = d.stringify();
    let parsed: { addition?: BSV.SceneAddition };
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(
        'could not parse ' + dictName + ' as JSON: ' + String(raw).substring(0, 200),
      );
    }

    const addition = parsed.addition;
    if (!addition) throw new Error('add_scenes: no addition found');
    const atIndex = Number(addition.at);
    const count = Number(addition.count);
    const name = String(addition.name || '').trim();
    if (Math.floor(atIndex) !== atIndex || atIndex < 0 || count !== 8 || !name) {
      throw new Error('add_scenes: malformed insertion point, count or name');
    }
    const before = at('live_set').getcount('scenes');
    if (atIndex > before) {
      throw new Error(
        'add_scenes: insertion point ' + atIndex + ' is past ' + before + ' scenes',
      );
    }

    const color = addition.color === undefined ? undefined : Number(addition.color);
    const tempo = addition.tempo === undefined ? undefined : Number(addition.tempo);
    if (
      color !== undefined &&
      (Math.floor(color) !== color || color < 0 || color > 0xffffff)
    ) {
      throw new Error('add_scenes: invalid scene color');
    }
    if (tempo !== undefined && (!isFinite(tempo) || tempo < 20 || tempo > 1000)) {
      throw new Error('add_scenes: tempo must be 20–1000 BPM');
    }
    let undoStep = false;
    try {
      at('live_set').call('begin_undo_step');
      undoStep = true;
    } catch (e) {
      post('bsv add_scenes: begin_undo_step unavailable — ' + describe(e) + '\n');
    }

    let created = 0;
    let configured = 0;
    let failed = 0;
    addingScenes = true;
    try {
      for (let i = 0; i < count; i++) {
        const s = atIndex + i;
        try {
          // Re-address the Song every time: at() is one reusable cursor, and
          // configuring the previous scene pointed it away from live_set.
          at('live_set').call('create_scene', s);
          created++;
        } catch (e) {
          failed += count - i;
          post('bsv add_scenes: create at ' + s + ' failed — ' + describe(e) + '\n');
          break;
        }

        try {
          const scene = at('live_set scenes ' + s);
          if (!exists(scene)) throw new Error('new scene did not resolve');
          setName(scene, name);
          if (color !== undefined) scene.set('color', color);
          if (tempo !== undefined) setSceneTempo(scene, tempo);
          configured++;
        } catch (e) {
          failed++;
          post('bsv add_scenes: configure scene ' + s + ' failed — ' + describe(e) + '\n');
        }
      }
    } finally {
      if (undoStep) {
        try {
          at('live_set').call('end_undo_step');
        } catch (e) {
          undoStep = false;
          post('bsv add_scenes: end_undo_step failed — ' + describe(e) + '\n');
        }
      }
      // Live may deliver the scenes observer callbacks just after create_scene
      // returns. Keep the burst muted briefly; Node emits one structural event
      // after this function's terminal result.
      addStructureTask.cancel();
      addStructureTask.schedule(100);
    }

    const result: BSV.ScenesAddedResult = {
      created: created,
      configured: configured,
      failed: failed,
      from: atIndex,
      to: atIndex + created - 1,
      undoStep: undoStep,
    };
    publish(RESULT_DICT, result);
    outlet(0, 'add_scenes_done', reqId, RESULT_DICT, Date.now() - t0);
  } catch (e) {
    fail(reqId, e);
  }
}

var addStructureTask = new Task(function () {
  addingScenes = false;
});

function applyStep(): void {
  const j = job;
  if (!j) {
    applyTask.cancel();
    return;
  }
  // One index across both lists: clips occupy [0, ops.length), scenes the rest.
  // Chunking across the boundary rather than restarting at it keeps a batch of
  // 49 clips and 3 scenes to a single tick.
  const total = j.ops.length + j.sceneOps.length;
  const end = Math.min(j.i + CHUNK, total);
  for (; j.i < end; j.i++) {
    try {
      if (j.i < j.ops.length) execOp(j.ops[j.i]);
      else execSceneOp(j.sceneOps[j.i - j.ops.length]);
    } catch (e) {
      j.skipped++;
    }
  }
  outlet(0, 'apply_progress', j.reqId, j.i, total);
  if (j.i >= total) {
    applyTask.cancel();
    finishJob();
  }
}

function finishJob(): void {
  const j = job!;
  const ms = Date.now() - j.t0;
  const result: BSV.ApplyResult = {
    applied: j.ok,
    skipped: j.skipped,
    // The whole batch, both kinds. A total that counted only clips would make a
    // scene-only write look like it did nothing at all.
    total: j.ops.length + j.sceneOps.length,
  };
  job = null;
  publish(RESULT_DICT, result);
  outlet(0, 'apply_done', j.reqId, RESULT_DICT, ms);
}

var applyTask = new Task(applyStep);
applyTask.interval = 2;

// --- move -------------------------------------------------------------
// Reordering scenes, which Live gives us no call for. See bridge/LOM.md: both
// Cycling '74's reference and Live 12.4.3's own docstring table have
// create_scene / delete_scene / duplicate_scene and no move of any kind.
//
// So a move is build-then-delete, in four passes:
//
//   1. create_scene at the destination, once per moved scene   (blank scenes)
//   2. duplicate_clip_to for every occupied slot                (the audio)
//   3. copy the scene's own properties across                   (the labels)
//   4. delete_scene at the source                               (irreversible)
//
// THIS IS THE ONLY WRITE IN THE PROJECT THAT CAN DESTROY WORK. Everything else
// renames or recolors something that still exists, and `inverseOps` reverses it
// out of the snapshot we already hold. Nothing in a snapshot can rebuild a
// deleted scene's clips, so pass 4 is one-way.
//
// Three consequences shape the code below:
//
// - The index arithmetic is NOT here. It's in core/src/sceneMove.ts with an
//   exhaustive test, and arrives as data. Pass 1 renumbers the whole set
//   underneath us, so the scenes pass 4 deletes are not at the indexes the UI
//   found them at — and that is exactly the sort of off-by-n that deletes a
//   song instead of moving it.
// - Pass 3 reads the properties off the source scene HERE rather than taking
//   them from the plan. `create_scene` makes a genuinely blank scene, and the
//   snapshot doesn't model everything a scene carries (no time signature), so
//   copying from the live object is both more complete and immune to a stale
//   snapshot. In this project the scene NAME IS THE MAPPING — a move that drops
//   names doesn't lose labels, it deletes the song from derivation.
// - Pass 4 doesn't run if pass 2 lost anything. Half a song moved is
//   recoverable by hand; half a song moved with the original already deleted is
//   not.

interface MoveJob {
  reqId: number;
  plan: BSV.MovePlan;
  /** Position across create → steps → remove, as one flat index. */
  i: number;
  created: number;
  copied: number;
  removed: number;
  failed: number;
  undoStep: boolean;
  t0: number;
}

var moveJob: MoveJob | null = null;

/**
 * The scene properties a move has to carry, since `create_scene` carries none.
 *
 * `color` is RGB rather than `color_index` for the reason the whole project
 * writes scene colors that way — `Scene.color_index` is documented "Can be None
 * for no color" and Max's LiveAPI cannot construct that None to write it back.
 *
 * Tempo and time signature are each a value plus an `_enabled` gate, and the
 * gate has to be written FIRST: with it off, the value reads back -1 whatever
 * you wrote. Same trap `setSceneTempo` exists for.
 */
function copySceneProps(fromPath: string, toPath: string): void {
  // Own cursors, NOT at(). at() hands back the same LiveAPI object every time,
  // so a source and a target taken from it are one object pointed at whichever
  // was requested last — and this function has to hold both at once. Reading
  // everything before repositioning would also work and is exactly the kind of
  // ordering dependency that breaks the first time someone adds a line.
  const from = new LiveAPI(function () {}, fromPath);
  if (!exists(from)) throw new Error('move: source scene ' + fromPath + ' did not resolve');
  const to = new LiveAPI(function () {}, toPath);
  if (!exists(to)) throw new Error('move: target scene ' + toPath + ' did not resolve');

  const name = gstr(from, 'name');
  const color = gnumOr(from, 'color', -1);
  const tempoOn = gbool(from, 'tempo_enabled');
  const tempo = gnum(from, 'tempo');
  const sigOn = gbool(from, 'time_signature_enabled');
  const sigNum = gnum(from, 'time_signature_numerator');
  const sigDen = gnum(from, 'time_signature_denominator');

  setName(to, name);
  if (color >= 0) to.set('color', color);

  if (tempoOn && tempo >= MIN_TEMPO) {
    to.set('tempo_enabled', 1);
    to.set('tempo', tempo);
  }
  if (sigOn && sigNum > 0 && sigDen > 0) {
    to.set('time_signature_enabled', 1);
    to.set('time_signature_numerator', sigNum);
    to.set('time_signature_denominator', sigDen);
  }
}

/**
 * Copy one clip across, to any slot on any track.
 *
 * `duplicate_clip_to` takes a **ClipSlot object**, not a path or an index, so
 * the target goes in as an id. It raises when the source slot is empty, when the
 * two tracks differ in type, and when either slot belongs to a group track — the
 * planners filter all three out, so a raise here means a plan disagrees with the
 * set and the caller needs to know rather than have it swallowed.
 *
 * Both ends are addressed independently because two callers need it that way: a
 * scene reorder moves clips down one track, and a clip drag moves them across
 * tracks too. One function rather than two nearly identical ones — this file has
 * no automated coverage, and a second copy of this dance is a second place for
 * the source/target mix-up below to be got wrong.
 */
function copyClip(fromT: number, fromS: number, toT: number, toS: number): void {
  const target = new LiveAPI(
    function () {},
    'live_set tracks ' + toT + ' clip_slots ' + toS,
  );
  if (!exists(target)) {
    throw new Error('move: target slot ' + toT + '/' + toS + ' did not resolve');
  }
  // A second cursor, because at() hands back the same object every time and both
  // ends of this call have to be held at once.
  const source = new LiveAPI(
    function () {},
    'live_set tracks ' + fromT + ' clip_slots ' + fromS,
  );
  if (!exists(source)) {
    throw new Error('move: source slot ' + fromT + '/' + fromS + ' did not resolve');
  }
  source.call('duplicate_clip_to', 'id', target.id);
}

function move(reqId: number, dictName: string): void {
  if (!deviceReady) return fail(reqId, 'device not ready');
  if (job || moveJob || clipJob) return fail(reqId, 'a write is already in progress');
  try {
    const d = new Dict(dictName);
    const raw = d.stringify();
    let parsed: { plan?: BSV.MovePlan };
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(
        'could not parse ' + dictName + ' as JSON: ' + String(raw).substring(0, 200),
      );
    }

    const plan = parsed.plan;
    const create = plan ? asList<number>(plan.create) : [];
    const steps = plan ? asList<BSV.MoveStep>(plan.steps) : [];
    const remove = plan ? asList<number>(plan.remove) : [];

    // A plan that would delete more than it creates is malformed, and the
    // failure mode is a set one scene shorter every time someone drags. Refuse
    // rather than execute a plan we can already see is wrong.
    if (create.length !== remove.length) {
      throw new Error(
        'move: plan creates ' + create.length + ' scenes but deletes ' +
          remove.length + ' — refusing',
      );
    }
    if (!create.length) return fail(reqId, 'move: empty plan');

    // Group the whole move into one entry in Live's undo history if Live will
    // let us. Undocumented (see bridge/LOM.md) and therefore wrapped: if it
    // isn't there, the move still runs, it just isn't undoable from Live.
    let undoStep = false;
    try {
      const song = at('live_set');
      song.call('begin_undo_step');
      undoStep = true;
    } catch (e) {
      post('bsv move: begin_undo_step unavailable — ' + describe(e) + '\n');
    }

    moveJob = {
      reqId: reqId,
      plan: { create: create, steps: steps, remove: remove },
      i: 0,
      created: 0,
      copied: 0,
      removed: 0,
      failed: 0,
      undoStep: undoStep,
      t0: Date.now(),
    };
    moveTask.repeat();
  } catch (e) {
    moveJob = null;
    fail(reqId, e);
  }
}

/** Total units of work in a plan, for chunking and progress. */
function moveTotal(j: MoveJob): number {
  return j.plan.create.length + j.plan.steps.length + j.plan.remove.length;
}

/**
 * One unit of the move. Creates run first, then a whole scene's clips plus its
 * properties, then the deletions.
 *
 * A scene is one unit rather than a clip, so a scene's clips and its properties
 * can't be split across a yield — leaving a half-populated scene visible in Live
 * for a frame is confusing, and leaving one visible forever if the device
 * reloads mid-move is worse.
 */
function moveStep(): void {
  const j = moveJob;
  if (!j) {
    moveTask.cancel();
    return;
  }
  const nCreate = j.plan.create.length;
  const nSteps = j.plan.steps.length;
  const total = moveTotal(j);
  const end = Math.min(j.i + CHUNK, total);
  // Its own cursor rather than at(). copySceneProps below repositions the shared
  // one, so a `song` taken from at() would be pointing at a Scene by the time
  // the next create_scene/delete_scene ran — and `call` on the wrong object is
  // the silent kind of wrong this file specialises in.
  const song = new LiveAPI(function () {}, 'live_set');
  if (!exists(song)) {
    j.failed++;
    moveTask.cancel();
    return finishMove();
  }

  for (; j.i < end; j.i++) {
    try {
      if (j.i < nCreate) {
        song.call('create_scene', j.plan.create[j.i]);
        j.created++;
      } else if (j.i < nCreate + nSteps) {
        const step = j.plan.steps[j.i - nCreate];
        const tracks = asList<number>(step.tracks);
        for (let k = 0; k < tracks.length; k++) {
          try {
            copyClip(tracks[k], step.from, tracks[k], step.to);
            j.copied++;
          } catch (e) {
            j.failed++;
            post(
              'bsv move: clip ' + tracks[k] + '/' + step.from + ' → ' + step.to +
                ' failed: ' + describe(e) + '\n',
            );
          }
        }
        copySceneProps('live_set scenes ' + step.from, 'live_set scenes ' + step.to);
      } else {
        // Nothing gets deleted if a single clip didn't make it. The scenes are
        // already duplicated at this point, so stopping here leaves the set
        // messy but complete — every clip still exists somewhere. Deleting
        // anyway would turn a recoverable mess into lost work.
        if (j.failed) break;
        song.call('delete_scene', j.plan.remove[j.i - nCreate - nSteps]);
        j.removed++;
      }
    } catch (e) {
      j.failed++;
      post('bsv move: step ' + j.i + ' failed: ' + describe(e) + '\n');
    }
  }

  outlet(0, 'move_progress', j.reqId, j.i, total);
  // `j.failed` short-circuits the delete pass above without advancing `i`, so
  // check for that as well as for reaching the end.
  if (j.i >= total || (j.failed && j.i >= nCreate + nSteps)) {
    moveTask.cancel();
    finishMove();
  }
}

function finishMove(): void {
  const j = moveJob!;
  const ms = Date.now() - j.t0;

  if (j.undoStep) {
    try {
      at('live_set').call('end_undo_step');
    } catch (e) {
      post('bsv move: end_undo_step failed — ' + describe(e) + '\n');
    }
  }

  const result = {
    created: j.created,
    copied: j.copied,
    removed: j.removed,
    failed: j.failed,
    undoStep: j.undoStep,
  };
  moveJob = null;
  publish(RESULT_DICT, result);
  outlet(0, 'move_done', j.reqId, RESULT_DICT, ms);

  if (result.failed) {
    post(
      'bsv move: ' + result.failed + ' operation(s) failed — the originals were NOT ' +
        'deleted. The set now holds both copies.\n',
    );
  }
}

var moveTask = new Task(moveStep);
moveTask.interval = 2;

// --- moving clips -----------------------------------------------------
// Dragging clips to another place in the grid. Slots only: nothing here creates
// or deletes a scene, so every index means afterwards what it meant before.
//
// The same copy-then-delete shape as the scene reorder, and the same two rules
// that shape it:
//
// - The ordering is NOT here. `core/src/clipMove.ts` sorts the copies against
//   the direction of travel so that no clip is overwritten before it has been
//   read, and they arrive already in that order. **Do not re-sort `steps`.**
//   Getting it wrong doesn't raise; it silently drops clips in the overlap.
// - Deletes don't run if any copy failed. Clips copied with the originals still
//   in place is a set someone can fix by hand. The other way round is not.

interface ClipMoveJob {
  reqId: number;
  steps: BSV.ClipMoveStep[];
  remove: Array<{ t: number; s: number }>;
  /** Position across steps → remove, as one flat index. */
  i: number;
  copied: number;
  removed: number;
  failed: number;
  undoStep: boolean;
  t0: number;
}

var clipJob: ClipMoveJob | null = null;

function move_clips(reqId: number, dictName: string): void {
  if (!deviceReady) return fail(reqId, 'device not ready');
  if (job || moveJob || clipJob) return fail(reqId, 'a write is already in progress');
  try {
    const d = new Dict(dictName);
    const raw = d.stringify();
    let parsed: { clipPlan?: BSV.ClipMovePlan };
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(
        'could not parse ' + dictName + ' as JSON: ' + String(raw).substring(0, 200),
      );
    }

    const plan = parsed.clipPlan;
    const steps = plan ? asList<BSV.ClipMoveStep>(plan.steps) : [];
    const remove = plan ? asList<{ t: number; s: number }>(plan.remove) : [];
    if (!steps.length) return fail(reqId, 'move_clips: empty plan');
    // More deletions than copies can only mean clearing slots nothing was moved
    // out of. Refuse rather than run a plan we can already see loses clips.
    if (remove.length > steps.length) {
      throw new Error(
        'move_clips: plan copies ' + steps.length + ' clips but deletes ' +
          remove.length + ' — refusing',
      );
    }

    // One entry in Live's undo history if Live will let us — see the same call
    // in `move`, and bridge/LOM.md on why it's wrapped.
    let undoStep = false;
    try {
      const song = at('live_set');
      song.call('begin_undo_step');
      undoStep = true;
    } catch (e) {
      post('bsv move_clips: begin_undo_step unavailable — ' + describe(e) + '\n');
    }

    clipJob = {
      reqId: reqId,
      steps: steps,
      remove: remove,
      i: 0,
      copied: 0,
      removed: 0,
      failed: 0,
      undoStep: undoStep,
      t0: Date.now(),
    };
    clipMoveTask.repeat();
  } catch (e) {
    clipJob = null;
    fail(reqId, e);
  }
}

/**
 * One chunk of the move: copies first, every one of them, then the deletions.
 *
 * A clip is one unit here where a whole scene is one unit in `moveStep`. It can
 * be, because nothing in this plan is renumbering the set underneath itself —
 * yielding between two clips leaves a grid that is merely part-way, not one
 * whose indexes have shifted.
 */
function clipMoveStep(): void {
  const j = clipJob;
  if (!j) {
    clipMoveTask.cancel();
    return;
  }
  const nSteps = j.steps.length;
  const total = nSteps + j.remove.length;
  const end = Math.min(j.i + CHUNK, total);

  while (j.i < end) {
    if (j.i < nSteps) {
      const step = j.steps[j.i];
      try {
        copyClip(step.fromT, step.fromS, step.toT, step.toS);
        j.copied++;
      } catch (e) {
        j.failed++;
        post(
          'bsv move_clips: ' + step.fromT + '/' + step.fromS + ' → ' + step.toT + '/' +
            step.toS + ' failed: ' + describe(e) + '\n',
        );
      }
    } else {
      // Nothing gets cleared if a copy was lost — see the header. Skipping the
      // whole delete pass rather than stopping the job keeps the counts honest
      // and still reports.
      if (j.failed === 0) {
        const gone = j.remove[j.i - nSteps];
        try {
          const slot = at('live_set tracks ' + gone.t + ' clip_slots ' + gone.s);
          // has_clip first: the slot may already be empty if the same drag's
          // copy pass moved something out of it, and delete_clip raises on one
          // that holds nothing.
          if (exists(slot) && gbool(slot, 'has_clip')) {
            slot.call('delete_clip');
            j.removed++;
          }
        } catch (e) {
          j.failed++;
          post(
            'bsv move_clips: clearing ' + gone.t + '/' + gone.s + ' failed: ' +
              describe(e) + '\n',
          );
        }
      }
    }
    j.i++;
  }

  outlet(0, 'move_progress', j.reqId, j.i, total);
  if (j.i >= total) {
    clipMoveTask.cancel();
    finishClipMove();
  }
}

function finishClipMove(): void {
  const j = clipJob;
  if (!j) return;
  if (j.undoStep) {
    try {
      at('live_set').call('end_undo_step');
    } catch (e) {
      post('bsv move_clips: end_undo_step failed — ' + describe(e) + '\n');
    }
  }
  const ms = Date.now() - j.t0;
  const result = {
    copied: j.copied,
    removed: j.removed,
    failed: j.failed,
    undoStep: j.undoStep,
  };
  clipJob = null;
  publish(RESULT_DICT, result);
  outlet(0, 'move_clips_done', j.reqId, RESULT_DICT, ms);

  if (result.failed) {
    post(
      'bsv move_clips: ' + result.failed + ' operation(s) failed — nothing was ' +
        'deleted. The originals are all still where they were.\n',
    );
  }
}

var clipMoveTask = new Task(clipMoveStep);
clipMoveTask.interval = 2;

// --- palette developer diagnostic -----------------------------------
// Live exposes no way to read its color palette, so derive it: make a scratch
// object, walk its color_index upward reading back the RGB Live assigns each
// one, then throw the object away. The sweep stops as soon as Live clamps the
// index — that's how the size is discovered rather than assumed.
//
// IT HAS TO BE A CLIP. Live's own docstrings differ per class, and only one of
// the three is a plain int:
//
//   Clip.color_index    "Get/set access to the color index of the Clip."
//   Scene.color_index   "... Can be None for no color."
//   Track.color_index   "... Can be None for no color."
//
// The first version swept a scratch *scene* and Live answered every write with
// "v8liveapi: set: unsupported property type": Max's LiveAPI can read an
// Optional[int] but cannot construct one to write. A scratch track would have
// failed the same way. This is also why execOp's set('color_index') has always
// worked — it writes clips.
//
// The failure was invisible for the usual reason. The writes silently did
// nothing, and `gnum` reported the still-unset property as 0 — a real palette
// slot — so i=0 "succeeded", i=1 "clamped", and a one-entry black palette got
// cached as though it were data. Three guards below: the object must resolve,
// reads go through gnumOr so absent stays distinct from slot 0, and the result
// is checked for being a possible palette at all.
//
// The app never calls this path. Its checked-in LIVE_PALETTE constant is what
// ships; this sweep exists only so a developer can verify or regenerate that
// constant after an Ableton update.

/** Distinct values in `xs`. A real palette is dozens; one or two means a broken read. */
function countDistinct(xs: number[]): number {
  const seen: { [k: string]: boolean } = {};
  let n = 0;
  for (let i = 0; i < xs.length; i++) {
    const k = String(xs[i]);
    if (!seen[k]) {
      seen[k] = true;
      n++;
    }
  }
  return n;
}

/** Raw atoms for a property, for the Max window. Never throws. */
function atomsOf(a: LiveAPI, prop: string): string {
  try {
    return JSON.stringify(a.get(prop));
  } catch (e) {
    return 'threw: ' + String((e as Error)?.message ?? e);
  }
}

function palette(reqId: number): void {
  if (!deviceReady) return fail(reqId, 'device not ready');
  // Appending a whole track to hold one clip is deliberate. create_clip only
  // works on an empty slot in a MIDI track, and picking one of the user's would
  // mean writing into material they own; a scratch track touches nothing, and
  // deleting it takes the clip with it, so cleanup is a single call.
  let scratchTrack = -1;
  const set = new LiveAPI(function () {}, 'live_set');
  try {
    if (set.getcount('scenes') < 1) throw new Error('set has no scene to hold a scratch clip');

    const before = set.getcount('tracks');
    // -1 appends, per create_midi_track's own docstring — not assumed.
    set.call('create_midi_track', -1);
    if (set.getcount('tracks') !== before + 1) throw new Error('could not create scratch track');
    scratchTrack = before;

    const base = 'live_set tracks ' + scratchTrack + ' clip_slots 0';
    const slot = new LiveAPI(function () {}, base);
    if (!exists(slot)) {
      throw new Error('scratch clip slot did not resolve (id ' + slot.id + ')');
    }
    slot.call('create_clip', 1); // one beat; length is irrelevant, we only read color

    const cl = new LiveAPI(function () {}, base + ' clip');
    // Guard one. The whole sweep reads through this object, and an unresolved
    // cursor answers every get with nothing — which is indistinguishable from
    // "slot 0, black" unless we check here.
    if (!exists(cl)) {
      throw new Error('scratch clip did not resolve (id ' + cl.id + ')');
    }

    const colors: number[] = [];
    let stoppedAt = -1;
    let stopReason = 'reached PALETTE_MAX';
    for (let i = 0; i < PALETTE_MAX; i++) {
      cl.set('color_index', i);
      // Guard two: gnumOr, not gnum. -1 keeps "Live gave us nothing" apart from
      // "Live gave us slot 0", which is the distinction the old code collapsed.
      const back = gnumOr(cl, 'color_index', -1);
      if (back !== i) {
        stoppedAt = i;
        stopReason = 'color_index read back as ' + back;
        break;
      }
      const rgb = gnumOr(cl, 'color', -1);
      if (rgb < 0) {
        stoppedAt = i;
        stopReason = 'color unreadable';
        break;
      }
      colors.push(rgb & 0xffffff);
    }

    // Guard three, outcome-based exactly like the slot-scan fallback: don't ask
    // whether the reads *looked* right, ask whether the answer can be a palette
    // at all. Live's is dozens of distinct colors, so anything degenerate means
    // an assumption broke — and then say which, in the one place that can say.
    const distinct = countDistinct(colors);
    if (colors.length < 2 || distinct < 2) {
      cl.set('color_index', 0);
      post(
        'bsv palette: sweep produced ' + colors.length + ' entr(ies), ' + distinct +
          ' distinct — refusing to cache it.\n' +
          '  stopped at index ' + stoppedAt + ': ' + stopReason + '\n' +
          '  scratch clip id ' + cl.id + ' on track ' + scratchTrack + '\n' +
          '  after set(color_index, 0) Live answers:\n' +
          '    color_index atoms: ' + atomsOf(cl, 'color_index') + '\n' +
          '    color atoms:       ' + atomsOf(cl, 'color') + '\n' +
          '    name atoms:        ' + atomsOf(cl, 'name') + '\n',
      );
      throw new Error(
        'palette sweep produced ' + colors.length + ' color(s), ' + distinct +
          ' distinct — see the Max window for what Live actually answered',
      );
    }

    post(
      'bsv palette: ' + colors.length + ' colors, ' + distinct + ' distinct (' +
        stopReason + ')\n',
    );
    const p: BSV.Palette = { count: colors.length, colors: colors };
    publish(PALETTE_DICT, p);
    outlet(0, 'palette_done', reqId, PALETTE_DICT);
  } catch (e) {
    fail(reqId, e);
  } finally {
    if (scratchTrack >= 0) {
      try {
        set.call('delete_track', scratchTrack);
      } catch (e) {
        post(
          'bsv: FAILED to remove scratch track at index ' + scratchTrack +
            ' — delete it by hand (it is the last track, named after Live default)\n',
        );
      }
    }
  }
}

// --- playback ---------------------------------------------------------
// One message for everything that makes Live make a sound. Each verb is a
// single LOM call, so none of this needs chunking, a Dict, or a reply — the
// answer the caller wants is the play state changing, and that arrives on its
// own through play_state.
//
// `verb` rather than one Max message per action because `stop` is a name Max
// itself uses in other contexts and a top-level global called `stop` is a trap
// waiting to be stepped on.

function playback(verb: string, i: number, j: number): void {
  if (!deviceReady) return fail(-1, 'device not ready');
  try {
    switch (String(verb)) {
      case 'clip': {
        // fire() on an empty slot triggers that slot's stop button instead,
        // which is Live's own behaviour and is what we want: ⌘-clicking an
        // empty cell stops the track, exactly as in the Session grid.
        const slot = at('live_set tracks ' + i + ' clip_slots ' + j);
        if (!exists(slot)) return;
        slot.call('fire');
        break;
      }
      case 'scene': {
        // Note: Live also *selects* the scene as a side effect of firing it.
        const sc = at('live_set scenes ' + i);
        if (!exists(sc)) return;
        sc.call('fire');
        break;
      }
      case 'song':
        at('live_set').call('start_playing');
        break;
      case 'stopTrack': {
        const tr = at('live_set tracks ' + i);
        if (!exists(tr)) return;
        tr.call('stop_all_clips');
        break;
      }
      case 'stopClips':
        at('live_set').call('stop_all_clips');
        break;
      case 'stopSong':
        at('live_set').call('stop_playing');
        break;
      default:
        fail(-1, 'unknown playback verb: ' + verb);
    }
  } catch (e) {
    fail(-1, e);
  }
}

// --- folding ----------------------------------------------------------
// Hide or reveal a group track's members, in Live itself.
//
// The one write in this file that isn't a set edit. It changes no clip, no
// scene and nothing about what plays; it moves Live's own Session view. That
// also means it is *not* wrapped in an undo step — folding a group is not a
// thing anyone wants back on ⌘Z, and Live doesn't put it there either.

function set_fold(t: number, folded: number): void {
  if (!deviceReady) return fail(-1, 'device not ready');
  try {
    const tr = at('live_set tracks ' + t);
    if (!exists(tr)) return;
    // fold_state is documented "only available if is_foldable = 1", so this is
    // a guard against writing an unavailable property rather than politeness.
    // is_foldable is also how the snapshot decides a track is a group, so a
    // track that fails here is one the grid should never have offered.
    if (!gbool(tr, 'is_foldable')) return fail(-1, 'track ' + t + ' is not a group');
    tr.set('fold_state', folded ? 1 : 0);
  } catch (e) {
    fail(-1, e);
  }
}

// --- play state -------------------------------------------------------
// Which slot is playing and which is blinking, per track.
//
// Per-track, not per-clip. Track.playing_slot_index and fired_slot_index cover
// the entire grid in two properties each, so watching the whole set costs
// 2 × trackCount observers. Per-clip observers would be 2 per slot — tens of
// thousands on a real set, which is exactly the chatty design the protocol
// rules exist to prevent.
//
// The report goes out as message atoms rather than a Dict, which is the
// opposite of the rule for the snapshot, and deliberately: dict names are
// global, so a push that can fire many times a second would race itself —
// v8 overwriting bsv_playstate before Node had finished reading the previous
// one. The payload is 1 + 2 × trackCount plain numbers with no punctuation in
// it, so atoms are safe here in a way clip names never are.

function playStateAtoms(): unknown[] {
  const set = at('live_set');
  const trackCount = set.getcount('tracks');
  const atoms: unknown[] = [gbool(set, 'is_playing') ? 1 : 0];
  for (let t = 0; t < trackCount; t++) {
    const a = at('live_set tracks ' + t);
    // gnumOr, not gnum: an unreadable property would come back 0 from gnum,
    // and "scene 0 is playing" is a plausible-looking lie. -1 is "nothing".
    atoms.push(gnumOr(a, 'playing_slot_index', -1));
    atoms.push(gnumOr(a, 'fired_slot_index', -1));
  }
  return atoms;
}

function sendPlayState(): void {
  try {
    const atoms = playStateAtoms();
    outlet(0, 'play_state', ...atoms);
  } catch (e) {
    fail(-1, e);
  }
}

function onPlayChange(): void {
  // Firing a scene changes every track at once. Coalesce to one report per
  // scheduler tick, or a 40-track set emits 40 identical-looking messages for
  // one launch.
  if (playDirty) return;
  playDirty = true;
  playTask.schedule(0);
}

var playTask = new Task(function () {
  playDirty = false;
  sendPlayState();
});

function sendSongPosition(): void {
  try {
    const set = at('live_set');
    const value = set.call('get_current_beats_song_time');
    const raw = Array.isArray(value) ? value.map(String).join('') : String(value || '');
    const fields = raw.trim().split('.');
    if (fields.length < 3) return fail(-1, 'unexpected song position: ' + raw);
    const bar = Number(fields[0]);
    const beat = Number(fields[1]);
    const sixteenth = Number(fields[2]);
    if (!isFinite(bar) || !isFinite(beat) || !isFinite(sixteenth)) {
      return fail(-1, 'unexpected song position: ' + raw);
    }

    // Live also returns ticks. The UI deliberately stops at sixteenths, so
    // keep the higher-frequency callbacks inside v8 rather than making React
    // redraw the app for a value it cannot display.
    const key = bar + '/' + beat + '/' + sixteenth;
    if (key === lastPositionKey) return;
    lastPositionKey = key;
    outlet(0, 'song_position', bar, beat, sixteenth);
  } catch (e) {
    fail(-1, e);
  }
}

function onSongPositionChange(): void {
  if (positionDirty) return;
  positionDirty = true;
  positionTask.schedule(0);
}

var positionTask = new Task(function () {
  positionDirty = false;
  sendSongPosition();
});

function watch_play(on: number): void {
  clearPlayObservers();
  if (Number(on) !== 1) return;
  if (!deviceReady) return fail(-1, 'device not ready');
  try {
    // getcount goes through the shared cursor; every observer needs its own
    // LiveAPI, because at() hands back the same object each call.
    const trackCount = at('live_set').getcount('tracks');

    const songObs = new LiveAPI(onPlayChange, 'live_set');
    songObs.property = 'is_playing';
    playObservers.push(songObs);

    const positionObs = new LiveAPI(onSongPositionChange, 'live_set');
    positionObs.property = 'current_song_time';
    const numeratorObs = new LiveAPI(onSongPositionChange, 'live_set');
    numeratorObs.property = 'signature_numerator';
    const denominatorObs = new LiveAPI(onSongPositionChange, 'live_set');
    denominatorObs.property = 'signature_denominator';
    playObservers.push(positionObs, numeratorObs, denominatorObs);

    for (let t = 0; t < trackCount; t++) {
      const p = new LiveAPI(onPlayChange, 'live_set tracks ' + t);
      p.property = 'playing_slot_index';
      const f = new LiveAPI(onPlayChange, 'live_set tracks ' + t);
      f.property = 'fired_slot_index';
      playObservers.push(p, f);
    }

    // Seed it, so the UI shows the truth immediately rather than staying blank
    // until the first launch.
    sendPlayState();
    sendSongPosition();
  } catch (e) {
    fail(-1, e);
  }
}

function clearPlayObservers(): void {
  playTask.cancel();
  positionTask.cancel();
  playDirty = false;
  positionDirty = false;
  lastPositionKey = '';
  for (let i = 0; i < playObservers.length; i++) {
    try {
      playObservers[i].property = '';
    } catch (e) {
      /* object may already be gone */
    }
  }
  playObservers = [];
}

// --- output meters ----------------------------------------------------
// Audio-output tracks use Live's momentary left/right peaks, combined to the
// louder channel. `output_meter_level` has a one-second hold and visibly lags a
// real meter; it remains only as the fallback for MIDI-only tracks, for which
// Live exposes no momentary property. The stereo properties cost more Live GUI
// work, which is why these observers exist only while the meter UI is open.

/** Roughly one frame at 30 Hz. Every frame carries the whole current set. */
var METER_INTERVAL_MS = 33;

function meterValue(args: unknown[], property: string): number | null {
  // Constructing a LiveAPI at a path can call its callback with ['id', N]
  // before the observed property reports. Treating the last numeric atom as a
  // level turns every such track into full scale after clamping. Meter updates
  // are either [property, value] or a bare [value]; nothing else is audio.
  let raw: unknown;
  if (args.length === 1) raw = args[0];
  else if (args.length >= 2 && args[0] === property) raw = args[args.length - 1];
  else return null;
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

function queueMeterLevel(t: number, level: number): void {
  const next = Math.max(0, Math.min(1, level));
  if (meterLevels[t] === next) return;
  meterLevels[t] = next;
}

function onMeterChange(
  t: number,
  channel: 'left' | 'right' | 'mono',
  property: string,
  args: unknown[],
): void {
  if (!metersWatching) return;
  const level = meterValue(args, property);
  if (level === null) return;
  if (channel === 'mono') {
    queueMeterLevel(t, level);
    return;
  }
  if (channel === 'left') meterLeft[t] = level;
  else meterRight[t] = level;
  queueMeterLevel(t, Math.max(meterLeft[t] ?? 0, meterRight[t] ?? 0));
}

function addMeterObserver(
  t: number,
  property: 'output_meter_left' | 'output_meter_right' | 'output_meter_level',
  channel: 'left' | 'right' | 'mono',
): void {
  const observer = new LiveAPI(
    function (args: unknown[]) { onMeterChange(t, channel, property, args); },
    'live_set tracks ' + t,
  );
  observer.property = property;
  meterObservers.push(observer);
}

function sendMeterLevels(): void {
  if (!metersWatching || !meterLevels.length) return;
  const atoms: unknown[] = [];
  for (let t = 0; t < meterLevels.length; t++) {
    atoms.push(t, meterLevels[t] === undefined ? 0 : meterLevels[t]);
  }
  outlet(0, 'meter_levels', ...atoms);
}

var meterTask = new Task(sendMeterLevels);
meterTask.interval = METER_INTERVAL_MS;

function watch_meters(on: number): void {
  clearMeterObservers();
  if (Number(on) !== 1) return;
  if (!deviceReady) return fail(-1, 'device not ready');
  metersWatching = true;
  try {
    const trackCount = at('live_set').getcount('tracks');
    for (let t = 0; t < trackCount; t++) {
      // Zero first. Reading output_meter_level here seeded Live's held peak,
      // which could make a never-active meter appear fully lit until its first
      // observer callback. Silence must render as silence from frame one.
      queueMeterLevel(t, 0);
      const track = at('live_set tracks ' + t);
      if (gbool(track, 'has_audio_output')) {
        addMeterObserver(t, 'output_meter_left', 'left');
        addMeterObserver(t, 'output_meter_right', 'right');
      } else {
        addMeterObserver(t, 'output_meter_level', 'mono');
      }
    }
    sendMeterLevels();
    meterTask.repeat();
  } catch (e) {
    clearMeterObservers();
    fail(-1, e);
  }
}

function clearMeterObservers(): void {
  // Set this before detaching properties: a late callback from an observer
  // being torn down must not schedule one last batch after watching is off.
  metersWatching = false;
  meterTask.cancel();
  meterLevels = [];
  meterLeft = [];
  meterRight = [];
  for (let i = 0; i < meterObservers.length; i++) {
    try {
      meterObservers[i].property = '';
    } catch (e) {
      /* object may already be gone */
    }
  }
  meterObservers = [];
}

// --- following Live ---------------------------------------------------
//
// Keeping up with edits the user makes in Live, without an observer per slot.
//
// The LOM has no aggregate "a clip in this track changed" signal — `clip_slots`
// is a *const* list, so it fires on membership (the scene count) and never on
// content. See *What the LOM does not have* in LOM.md. The complete alternative
// is `has_clip` per slot, which is trackCount x sceneCount observers: ~4,400 on
// a full-size set against the 2 x trackCount that play state costs.
//
// So watch the cursor instead. `selected_track` and `selected_scene` are both
// observable, and Live defines `highlighted_clip_slot` as being derived from
// them, so those two ARE the Session cursor — two observers for the whole grid.
//
// **The cursor says where to look; the re-read says what happened.** Nothing
// here tries to detect a drag or classify a drop, which is what makes it robust:
// there is no inference to get wrong. A selection change that turns out to be
// an ordinary click re-reads a track, finds it unchanged, and publishes nothing.
//
// Measured against a real set, a click-and-drag in one motion on an *unselected*
// clip fires twice — at the source on grab, at the destination on drop. That is
// what makes `selPrevTrack` the source of a move.
//
// **What this does not catch**: edits that move nothing. Deleting, renaming or
// recoloring a clip in place leaves the cursor where it is, so no callback
// fires. Those need a full re-read, which is what the client's `changed`
// handling and its own refresh are for.

/** How long to let the cursor settle before re-reading. */
const SEL_DEBOUNCE_MS = 100;

var selObservers: LiveAPI[] = [];
/** Last cursor seen, as raw ids — comparing these needs no index resolution. */
var selTrackId = 0;
var selSceneId = 0;
/** Track index the cursor was in before its current position — a move's source. */
var selPrevTrack = -1;
/** Track indexes awaiting a re-read, used as a set. */
var selDirty: { [t: string]: boolean } = {};
/** LOM id -> track index. Rebuilt whenever the set's structure changes. */
var trackIndexById: { [id: string]: number } | null = null;
/**
 * Monotonic revision of everything published, snapshots and deltas alike.
 *
 * Not a timestamp: two publishes inside one millisecond have to be orderable,
 * and that ordering is the only thing standing between a client and a delta
 * merged onto the wrong base.
 */
var rev = 0;

function nextRev(): number {
  rev = rev + 1;
  return rev;
}

/**
 * A track's index from its LOM id, through a cache.
 *
 * Resolving this by walking costs ~11ms on a real set, measured — which is
 * nothing once, and a great deal on every click the user makes in Live. The
 * cache is dropped on any structural change, because that is exactly when an
 * index stops meaning what it meant.
 */
function trackIndexOf(id: number): number {
  if (!id) return -1;
  if (!trackIndexById) {
    const map: { [id: string]: number } = {};
    const count = at('live_set').getcount('tracks');
    for (let t = 0; t < count; t++) map[String(at('live_set tracks ' + t).id)] = t;
    trackIndexById = map;
  }
  const found = trackIndexById[String(id)];
  return found === undefined ? -1 : found;
}

/**
 * Every clip in one track, read by path.
 *
 * Deliberately *not* the snapshot's id-addressed fast path. This reads one
 * track — ~11ms on a 64-scene set — so the fast path would save nothing worth a
 * second way of doing it, and LOM.md records `goto('id N')` as not resolving
 * against a real set. Path addressing is the form this project has actually
 * watched work.
 */
function readTrackClips(t: number, sceneCount: number, out: BSV.Clip[]): void {
  for (let s = 0; s < sceneCount; s++) {
    const slotPath = 'live_set tracks ' + t + ' clip_slots ' + s;
    const slot = at(slotPath);
    if (!exists(slot) || !gbool(slot, 'has_clip')) continue;
    const c = at(slotPath + ' clip');
    if (!exists(c)) continue;
    out.push({
      t: t,
      s: s,
      name: gstr(c, 'name'),
      colorIndex: gnum(c, 'color_index'),
      color: gnum(c, 'color'),
      length: gnum(c, 'length'),
      isMidi: gbool(c, 'is_midi_clip'),
    });
  }
}

function onSelectionChange(): void {
  if (!selObservers.length) return;
  try {
    const view = at('live_set view');
    const trackId = gid(view, 'selected_track');
    const sceneId = gid(view, 'selected_scene');
    // Two observers watch one cursor, so a move that changes track and scene
    // together fires both. Without this the same position is handled twice.
    if (trackId === selTrackId && sceneId === selSceneId) return;
    selTrackId = trackId;
    selSceneId = sceneId;

    // Both ends, and this is the part that makes the scheme work. The cursor
    // lands on a move's DESTINATION; the position it left is the SOURCE.
    // Marking only the destination would learn that a clip arrived and never
    // that it left, which draws it in two places at once.
    const t = trackIndexOf(trackId);
    if (t >= 0) selDirty[String(t)] = true;
    if (selPrevTrack >= 0) selDirty[String(selPrevTrack)] = true;
    selPrevTrack = t;

    // Debounced, and not only to coalesce. Whether Live moves the selection
    // before or after the clip actually lands is unverified, so reading
    // synchronously here risks seeing the set as it was a moment ago.
    selTask.cancel();
    selTask.schedule(SEL_DEBOUNCE_MS);
  } catch (e) {
    fail(-1, e);
  }
}

function flushSelection(): void {
  try {
    // Our own write is mid-flight. Its result is reconciled by the client from
    // the batch it sent, and a delta computed against a half-written set would
    // race that. Come back rather than dropping the dirty tracks.
    if (job || moveJob) {
      selTask.schedule(SEL_DEBOUNCE_MS);
      return;
    }

    const tracks: number[] = [];
    for (const k in selDirty) {
      if (Object.prototype.hasOwnProperty.call(selDirty, k)) tracks.push(Number(k));
    }
    selDirty = {};
    if (!tracks.length) return;
    tracks.sort(function (a, b) {
      return a - b;
    });

    const t0 = Date.now();
    const sceneCount = at('live_set').getcount('scenes');
    const clips: BSV.Clip[] = [];
    const scanned: number[] = [];
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const track = at('live_set tracks ' + t);
      // A track that no longer resolves was deleted under us. Say nothing about
      // it: claiming it is empty would delete its clips from the client's copy,
      // and the structure observer is already sending everyone for a full walk.
      if (!exists(track)) continue;
      // Group tracks have no real clip slots of their own — what a group slot
      // shows is derived from its members. Same skip as the snapshot's scan.
      if (gbool(track, 'is_foldable')) {
        scanned.push(t);
        continue;
      }
      scanned.push(t);
      readTrackClips(t, sceneCount, clips);
    }
    if (!scanned.length) return;

    const prevRev = rev;
    const payload: BSV.SnapshotDelta = {
      rev: nextRev(),
      prevRev: prevRev,
      tracks: scanned,
      clips: clips,
      ms: Date.now() - t0,
    };
    publish(DELTA_DICT, payload);
    outlet(0, 'delta', DELTA_DICT);
  } catch (e) {
    fail(-1, e);
  }
}

var selTask = new Task(flushSelection);

function watch_selection(on: number): void {
  clearSelObservers();
  if (Number(on) !== 1) return;
  try {
    const t = new LiveAPI(onSelectionChange, 'live_set view');
    t.property = 'selected_track';
    const s = new LiveAPI(onSelectionChange, 'live_set view');
    s.property = 'selected_scene';
    selObservers = [t, s];

    // Seed from where the cursor is now rather than waiting to be told. An
    // observer on an object-valued property was not seen to fire on attach the
    // way the numeric ones do, and without a starting position the first move
    // would have no previous track — so its source would go unread, which is
    // the one failure this whole design is built to avoid.
    const view = at('live_set view');
    selTrackId = gid(view, 'selected_track');
    selSceneId = gid(view, 'selected_scene');
    selPrevTrack = trackIndexOf(selTrackId);
  } catch (e) {
    fail(-1, e);
  }
}

function clearSelObservers(): void {
  selTask.cancel();
  for (let i = 0; i < selObservers.length; i++) {
    try {
      selObservers[i].property = '';
    } catch (e) {
      /* object may already be gone */
    }
  }
  selObservers = [];
  selDirty = {};
  selPrevTrack = -1;
  selTrackId = 0;
  selSceneId = 0;
}

// --- observers --------------------------------------------------------
// Structure only: the track and scene lists. Content is followed by watching
// the selection instead — see *following Live* above.

function onStructureChange(): void {
  // Every index now means something different, so anything addressed by one is
  // stale: the id cache, the dirty set, and the cursor's previous position.
  // Clients re-walk on `changed`, which is the only honest answer to a set that
  // just renumbered itself.
  trackIndexById = null;
  selDirty = {};
  selPrevTrack = -1;
  selTask.cancel();
  // add_scenes creates a fixed run synchronously. Its Node-side completion
  // broadcasts one structural change after all eight rows are configured;
  // emitting once per create would launch eight overlapping full snapshots.
  if (addingScenes) return;
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

// --- developer diagnostics --------------------------------------------
//
// `diag <what> [arg]`. Never called by the shipped UI — the same standing as
// `palette`, and for the same reason: these settle questions about what Live
// actually does that no amount of reading the docs will answer.
//
// **Answers go to the Max window, not over the wire.** Every question here is
// about what happens *while you drag something in Live*, so the readout has to
// be somewhere you can watch without leaving Live.
//
// Every probe is a read. Live's binary carries the error string "Changes
// cannot be triggered by notifications", so a write from inside an observer
// callback throws — `diagWatch` deliberately never writes.

/** Selection observers from `diag watch`. */
var diagObservers: LiveAPI[] = [];
/** Slot observers from `diag attach`, kept apart so a watch survives one. */
var diagAttached: LiveAPI[] = [];
/** Last cursor position reported, so the watch log shows moves not repeats. */
var diagLastSel = '';

/**
 * Does `goto('id N')` resolve?
 *
 * [`LOM.md`](../LOM.md) records a measurement saying it doesn't — every one of
 * 24 tracks fell back — which is why the slot scan uses path addressing and
 * costs ~758ms of a ~946ms walk. Worth re-asking because it decides two things
 * at once: whether that scan can be made fast, and whether an observer can be
 * attached by id. The second matters more. An index-addressed observer silently
 * re-points when a scene is inserted above it, so if id addressing is dead then
 * every structural change invalidates the whole observer set.
 */
function diagIds(): void {
  const trackIds = gids(at('live_set'), 'tracks');
  post('bsv diag ids: live_set tracks -> ' + trackIds.length + ' id(s)\n');
  if (!trackIds.length) return;

  const byId = at('id ' + trackIds[0]);
  const trackOk = exists(byId);
  const viaId = trackOk ? gstr(byId, 'name') : '';
  const viaPath = gstr(at('live_set tracks 0'), 'name');
  post(
    '  track 0 by id ' + trackIds[0] + ': ' + (trackOk ? 'RESOLVED' : 'FAILED') +
      ' name="' + viaId + '" — by path: "' + viaPath + '"\n',
  );

  const slotIds = gids(at('live_set tracks 0'), 'clip_slots');
  if (!slotIds.length) {
    post('  track 0 reports no clip_slots\n');
    return;
  }
  const slot = at('id ' + slotIds[0]);
  const slotOk = exists(slot);
  post(
    '  slot 0 by id ' + slotIds[0] + ': ' + (slotOk ? 'RESOLVED' : 'FAILED') +
      " get('clip') -> " + JSON.stringify(slot.get('clip')) + '\n',
  );
  post(
    '  => id addressing ' + (trackOk && slotOk ? 'WORKS' : 'is BROKEN') + '\n',
  );
}

/**
 * Is `ClipSlot.color_index` the contained clip's color on an *ordinary* slot?
 *
 * Live's own docstring is generic — "Returns the canonical color index for the
 * clip slot or None if it does not exist" — while the Cycling '74 page only
 * describes the group-track case. If the generic reading holds, one observer
 * per slot reports a clip added (None -> n), removed (n -> None) *and*
 * recolored (n -> m). That's the work of a `has_clip` observer plus a per-clip
 * one, with no per-clip observer lifecycle to manage — clip slots never come
 * and go except structurally, but clips do.
 */
function diagSlot(): void {
  const set = at('live_set');
  const trackCount = set.getcount('tracks');
  const sceneCount = set.getcount('scenes');

  for (let t = 0; t < trackCount; t++) {
    if (gbool(at('live_set tracks ' + t), 'is_foldable')) continue;
    for (let s = 0; s < sceneCount; s++) {
      const path = 'live_set tracks ' + t + ' clip_slots ' + s;
      const slot = at(path);
      if (!exists(slot) || !gbool(slot, 'has_clip')) continue;

      // Read the slot's own answers before the cursor moves to the clip.
      const slotIndex = gnumOr(slot, 'color_index', -1);
      const slotRgb = gnumOr(slot, 'color', -1);
      const clip = at(path + ' clip');
      const clipIndex = gnumOr(clip, 'color_index', -1);
      const clipRgb = gnumOr(clip, 'color', -1);
      const match = slotIndex >= 0 && slotIndex === clipIndex;

      post('bsv diag slot: occupied slot (' + t + ',' + s + ')\n');
      post('  slot color_index=' + slotIndex + ' color=' + slotRgb + '\n');
      post('  clip color_index=' + clipIndex + ' color=' + clipRgb + '\n');
      post(
        '  => ' +
          (match
            ? 'MATCH — one color_index observer per slot covers add, remove and recolor'
            : 'NO MATCH — ClipSlot.color_index does not mirror an ordinary ' +
              "slot's clip, so occupancy still needs has_clip") + '\n',
      );

      // The other half: an empty slot has to answer "None", not slot 0. gnumOr
      // is what keeps those apart — gnum would report both as a real color.
      for (let e = 0; e < sceneCount; e++) {
        const empty = at('live_set tracks ' + t + ' clip_slots ' + e);
        if (!exists(empty) || gbool(empty, 'has_clip')) continue;
        const emptyIndex = gnumOr(empty, 'color_index', -1);
        post(
          '  empty slot (' + t + ',' + e + '): color_index=' + emptyIndex +
            (emptyIndex === -1
              ? ' — None, so occupancy is readable from this property alone'
              : ' — a real value, so None is NOT how Live reports an empty slot') +
            '\n',
        );
        return;
      }
      post('  (no empty slot on this track to compare against)\n');
      return;
    }
  }
  post('bsv diag slot: no occupied non-group slot found\n');
}

/**
 * Where Live's Session cursor is, and how wide the selection is.
 *
 * Live documents `highlighted_clip_slot` as "the clip slot, defined via the
 * selected track and scene", so `selected_track` + `selected_scene` — both
 * observable — *are* the cursor.
 *
 * `Track.is_part_of_selection` is readable but **not** observable, and what it
 * means is the open question. If it reports a track covered by a selected
 * *block of clips*, then a selection-driven resync can widen to cover a
 * rectangle drag. If it only reports a selected track *header*, it says nothing
 * about clips and a wide drag can only be caught by a full re-read.
 *
 * To settle it: select a 3x3 block of clips in Live, then run `diag sel`.
 * Three tracks listed means the wide reading holds.
 */
function diagSelection(label: string, dedupe: boolean): void {
  const t0 = Date.now();
  const view = at('live_set view');
  const trackId = gid(view, 'selected_track');
  const sceneId = gid(view, 'selected_scene');
  const slotId = gid(view, 'highlighted_clip_slot');
  const detailId = gid(view, 'detail_clip');

  const set = at('live_set');
  const trackCount = set.getcount('tracks');
  const sceneCount = set.getcount('scenes');

  // Resolving an id to an index costs a walk. A real implementation would cache
  // the map and rebuild it on structural change; timing it here is what says
  // whether that caching is required or merely tidy.
  let tIndex = -1;
  const inSelection: number[] = [];
  for (let t = 0; t < trackCount; t++) {
    const a = at('live_set tracks ' + t);
    if (Number(a.id) === trackId) tIndex = t;
    if (gbool(a, 'is_part_of_selection')) inSelection.push(t);
  }
  let sIndex = -1;
  for (let s = 0; s < sceneCount; s++) {
    if (Number(at('live_set scenes ' + s).id) === sceneId) {
      sIndex = s;
      break;
    }
  }

  const key = tIndex + ':' + sIndex;
  if (dedupe && key === diagLastSel) return;
  diagLastSel = key;

  post(
    'bsv diag ' + label + ': track ' + tIndex + ' scene ' + sIndex +
      ' | slot id ' + slotId + ' detail_clip id ' + detailId +
      ' | is_part_of_selection [' + inSelection.join(' ') + ']' +
      ' | resolved in ' + (Date.now() - t0) + 'ms\n',
  );
}

function onDiagSelectionChange(): void {
  // Deduped: both observers point at the same cursor, so a move that changes
  // track and scene together would otherwise log the same position twice and
  // make the lines uncountable — which is the one thing this has to get right.
  diagSelection('sel*', true);
}

/**
 * Log every selection change.
 *
 * The whole selection-driven resync idea rests on one unverified assumption:
 * that moving a clip in Live moves the Session cursor, at the source when you
 * pick it up and at the target when you drop it. Turn this on, drag a clip, and
 * read the answer off the Max window.
 *
 * **What a pass looks like: two lines** — one naming the source slot, one
 * naming the target. One line means only the drop is visible, and a resync
 * driven by this would leave the source stale, drawing the clip in both places.
 */
function diagWatch(on: number): void {
  clearDiagObservers();
  if (Number(on) !== 1) {
    post('bsv diag: selection watch OFF\n');
    return;
  }
  const t = new LiveAPI(onDiagSelectionChange, 'live_set view');
  t.property = 'selected_track';
  const s = new LiveAPI(onDiagSelectionChange, 'live_set view');
  s.property = 'selected_scene';
  diagObservers = [t, s];
  post(
    'bsv diag: selection watch ON. Drag a clip to another slot and count the ' +
      'lines — two (source, then target) is what the resync design needs; one ' +
      'means the source slot goes stale.\n',
  );
}

function clearDiagObservers(): void {
  for (let i = 0; i < diagObservers.length; i++) {
    try {
      diagObservers[i].property = '';
    } catch (e) {
      /* object may already be gone */
    }
  }
  diagObservers = [];
  diagLastSel = '';
}

/**
 * What one track's occupancy rescan costs — the read a selection-driven resync
 * would actually perform.
 *
 * The design rests on this being cheap enough to run on every selection change,
 * so measure it rather than extrapolating from the snapshot's per-slot average.
 */
function diagScan(t: number): void {
  const index = Math.max(0, Number(t) || 0);
  const sceneCount = at('live_set').getcount('scenes');
  const t0 = Date.now();
  let occupied = 0;
  for (let s = 0; s < sceneCount; s++) {
    const slot = at('live_set tracks ' + index + ' clip_slots ' + s);
    if (exists(slot) && gbool(slot, 'has_clip')) occupied++;
  }
  const ms = Date.now() - t0;
  post(
    'bsv diag scan: track ' + index + ' — ' + sceneCount + ' slots in ' + ms +
      'ms (' + (sceneCount ? (ms / sceneCount).toFixed(3) : '0') + 'ms/slot), ' +
      occupied + ' occupied\n',
  );
}

/**
 * What N observers cost to attach and to release.
 *
 * Attaching is synchronous and **will freeze Live for the duration** — that is
 * the measurement, not a bug. If the total turns out to be the problem rather
 * than the per-observer cost, `apply` already shows how to spread it over a
 * `Task` in chunks of CHUNK.
 *
 * The number to watch for afterwards isn't in this log: use Live normally with
 * the observers live — delete a scene, undo something — and see whether *Live*
 * got slower. That's the cost a user would notice and blame the device for.
 */
function diagAttach(n: number): void {
  diagDetach();
  const want = Math.max(1, Math.min(Number(n) || 500, DIAG_ATTACH_MAX));
  const set = at('live_set');
  const trackCount = set.getcount('tracks');
  const sceneCount = set.getcount('scenes');
  const t0 = Date.now();
  for (let t = 0; t < trackCount && diagAttached.length < want; t++) {
    for (let s = 0; s < sceneCount && diagAttached.length < want; s++) {
      const o = new LiveAPI(function () {}, 'live_set tracks ' + t + ' clip_slots ' + s);
      o.property = 'color_index';
      diagAttached.push(o);
    }
  }
  const made = diagAttached.length;
  const ms = Date.now() - t0;
  post(
    'bsv diag attach: ' + made + ' slot observers in ' + ms + 'ms (' +
      (made ? (ms / made).toFixed(3) : '0') + 'ms each). Live was frozen for ' +
      'that whole time. Now use Live normally and see whether IT feels ' +
      'different. `diag detach` when done.\n',
  );
}

function diagDetach(): void {
  if (!diagAttached.length) return;
  const n = diagAttached.length;
  const t0 = Date.now();
  for (let i = 0; i < diagAttached.length; i++) {
    try {
      diagAttached[i].property = '';
    } catch (e) {
      /* object may already be gone */
    }
  }
  diagAttached = [];
  post('bsv diag detach: released ' + n + ' observers in ' + (Date.now() - t0) + 'ms\n');
}

function diag(what: string, arg: number): void {
  if (!deviceReady) {
    post('bsv diag: device not ready\n');
    return;
  }
  const w = String(what || '');
  try {
    if (w === 'ids') diagIds();
    else if (w === 'slot') diagSlot();
    else if (w === 'sel') diagSelection('sel', false);
    else if (w === 'watch') diagWatch(arg);
    else if (w === 'scan') diagScan(arg);
    else if (w === 'attach') diagAttach(arg);
    else if (w === 'detach') diagDetach();
    else {
      post(
        'bsv diag: unknown "' + w + '". Try: ids | slot | sel | watch 0|1 | ' +
          'scan <track> | attach <n> | detach\n',
      );
    }
  } catch (e) {
    post('bsv diag ' + w + ': ' + describe(e) + '\n');
  }
}

function anything(): void {
  post('bsv lom: unhandled message "' + messagename + '"\n');
}

function notifydeleted(): void {
  clearObservers();
  clearPlayObservers();
  clearMeterObservers();
  clearSelObservers();
  clearDiagObservers();
  diagDetach();
  applyTask.cancel();
  moveTask.cancel();
  addStructureTask.cancel();
  addingScenes = false;
  // An undo step left open would swallow everything the user does next into our
  // half-finished move. Closing it is the one bit of cleanup here that touches
  // Live rather than just releasing our own handles.
  if (moveJob && moveJob.undoStep) {
    try {
      at('live_set').call('end_undo_step');
    } catch (e) {
      /* device is going away; nothing useful left to do */
    }
  }
  moveJob = null;
}
