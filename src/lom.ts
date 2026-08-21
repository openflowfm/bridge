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
//      select_scene <scene> | select_track <track> | set_fold <track> <0|1>
//      set_transport <encodedPatch> | set_mixer <encodedTargetAndPatch>
//      set_device <encodedTargetAndPatch>
//      watch_chains <encodedWatchList>
//      watch_play <0|1> | watch_meters <0|1> | watch_sends <0|1> | watch_transport <0|1>
//      watch_status <0|1> | watch_selection <0|1> | ping | set_info
// out: ready | snapshot_progress <reqId> <n> <total>
//      snapshot_done <reqId> <dict> <ms> | apply_progress <reqId> <n> <total>
//      apply_done <reqId> <dict> <ms> | add_scenes_done <reqId> <dict> <ms>
//      move_progress <reqId> <n> <total>
//      move_done <reqId> <dict> <ms> | move_clips_done <reqId> <dict> <ms>
//      palette_done <reqId> <dict> | changed <kind> | delta <dict>
//      set_info_done <dict>
//      play_state <isPlaying> <t0 playing> <t0 fired> <t1 playing> … | err <reqId> <msg>
//      song_position <bar> <beat> <sixteenth>
//      transport_state <encodedState>
//      meter_levels <masterLevel> <track0> <level0> <track1> <level1> …
//      clip_status <t> <pos> <loopStart> <loopEnd> <looping> <recording>
//        <inSeconds> <sigNum> <sigDen> … (nine atoms per *playing* track)
//      mixer_state <encodedState>
//      chain_state <encodedState> | chain_values <encodedChanges>
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
/** A clip's notes, read on request so a client can work out the harmony. */
const NOTES_DICT = 'bsv_notes';

/** LOM ops per scheduler tick — keeps Live's UI responsive. */
const CHUNK = 50;

/**
 * How much of each snapshot pass runs in one tick.
 *
 * `slots` is the one that matters and the one to move first: it is
 * `trackCount x sceneCount`, it is ~60% of the walk, and it is what
 * `npm run dev:diag -- scan <track>` measures. The other three are sized to a
 * comparable slice of work rather than tuned — a track costs ~7 gets, a scene
 * ~5, a clip ~6, and a slot 1 or 2.
 */
const SNAP_CHUNK = { tracks: 48, scenes: 96, slots: 512, clips: 96 };

/** Scheduler gap between snapshot chunks, matching the write tasks. */
const SNAP_INTERVAL_MS = 2;

/**
 * How many times a walk may start over because the set changed under it.
 *
 * A restructure mid-walk is rare — the common snapshot happens just after a set
 * opens, when nobody is editing — so this is a correctness guard rather than a
 * hot path. Three, then say so: a set being actively restructured is not one
 * that can be read coherently, and spinning forever hides that.
 */
const SNAP_MAX_RESTARTS = 3;

/** Safety stop for the palette sweep; real palettes are far smaller. */
const PALETTE_MAX = 200;

/**
 * Runaway guard for `diag attach`. A full-size set is ~4,400 slots, so this
 * leaves room to go past one and still not wedge Live on a typo.
 */
const DIAG_ATTACH_MAX = 8000;

/** Runaway guard for an accidentally enormous scheduled scroll probe. */
const DIAG_SCROLL_MAX = 2000;

/**
 * How long a device-chain change settles before the runs are re-read.
 *
 * Adding a device fires the run's membership observer and then the new device's
 * own, and Live rearranges a rack over several turns. One re-read after the
 * dust settles beats four describing a shape that is still moving.
 */
const CHAIN_DEBOUNCE_MS = 60;

/** Keep consecutive view commands in distinct Live UI turns. */
const DIAG_SCROLL_INTERVAL_MS = 50;

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
/** Activator, Solo, Arm, volume, pan and send observers, alive only with the mixer panel. */
var mixerObservers: LiveAPI[] = [];
/** Return-track membership changes rebuild the send parameter list. */
var mixerStructureObserver: LiveAPI | null = null;
var transportObservers: LiveAPI[] = [];
/** A burst of play-state callbacks is pending a single coalesced report. */
var playDirty = false;
/** Song time has changed and a position report is pending. */
var positionDirty = false;
/** Last displayed position, so sub-sixteenth callbacks stay local. */
var lastPositionKey = '';
/** Control-bar changes are coalesced and duplicate full states stay in v8. */
var transportDirty = false;
var lastTransportKey = '';
/** Last value seen per track, used to suppress duplicate callbacks. */
var meterLevels: number[] = [];
/** Latest momentary channel values; combined into meterLevels with max(L, R). */
var meterLeft: number[] = [];
var meterRight: number[] = [];
/** The master track is not part of Song.tracks, so its meter state is separate. */
var masterMeterLevel = 0;
var masterMeterLeft = 0;
var masterMeterRight = 0;
var metersWatching = false;
/** Send parameters are the expensive optional section of the mixer watch. */
var sendsWatching = false;
/** Latest coherent control state; observer callbacks update this cache in place. */
var mixerState: BSV.MixerState | null = null;
var mixerDirty = false;
var lastMixerKey = '';
var job: ApplyJob | null = null;
/**
 * A structural job of our own is running — `add_scenes` or `move`.
 *
 * Both create and delete scenes, and each `create_scene` / `delete_scene` trips
 * the `live_set scenes` observer. Left unmuted that is one `changed structure`
 * per scene touched, and every one of those sends **every connected client** off
 * on a full ~950ms walk — of a set that is halfway through being rearranged.
 * Reading a set mid-move is worse than reading it late.
 *
 * So the burst is muted and Node emits exactly one structural event after the
 * terminal result. The index-addressed state is still dropped on every callback;
 * it's only the outward message that waits.
 */
var structuralJob = false;

// --- helpers ----------------------------------------------------------

/**
 * The script can be recompiled while the containing device stays loaded.
 * `deviceReady` then resets even though `live.thisdevice` will not emit its
 * automatic initialization bang again. The patcher consumes this private
 * signal and replays `init` only after its own initialization latch is set.
 */
function loadbang(): void {
  outlet(0, 'boot');
}

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

/** JSON encoded into the punctuation-safe subset Max carries as one atom. */
function encodeMaxAtom(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value)).replace(/[!'()*]/g, function (c) {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

function decodeMaxAtom(value: unknown): unknown {
  try {
    return JSON.parse(decodeURIComponent(String(value || '')));
  } catch (e) {
    return null;
  }
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
  const names = [
    SNAPSHOT_DICT,
    RESULT_DICT,
    PALETTE_DICT,
    SET_DICT,
    DELTA_DICT,
    OPS_DICT,
    NOTES_DICT,
  ];
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
 * The class name of a track's instrument, or `''` when it has none.
 *
 * `Device.type === 1` is Live's own word for "instrument", which is steadier
 * than matching class names against a list: a Drum Rack, an Operator and a
 * third-party plugin all answer 1, and only the instrument does. What the class
 * *means* — that `DrumGroupDevice` is drums and its notes are not harmony — is
 * decided in `core/`, where it can be tested.
 */
function instrumentOf(t: number): string {
  const path = 'live_set tracks ' + t;
  let count = 0;
  try {
    count = at(path).getcount('devices');
  } catch (e) {
    return '';
  }
  for (let i = 0; i < count && i < DEVICE_COUNT_MAX; i++) {
    const device = at(path + ' devices ' + i);
    if (!exists(device)) continue;
    if (gnumOr(device, 'type', 0) === 1) return gstr(device, 'class_name');
  }
  return '';
}

/** Anything past this in one clip is a generative patch, not a progression. */
const NOTE_COUNT_MAX = 4096;

/**
 * Every note in one clip.
 *
 * **This is the only dict-returning LOM call in the project**, and the shape it
 * hands back to `[v8]` is the part that could not be checked without Live open.
 * Max's convention is that a function returning a dictionary returns its
 * *name*, which is then wrapped — so that is what this tries first, and every
 * other shape is reported to the Max window with what it actually was rather
 * than being guessed at. A clip we cannot read comes back empty, which draws no
 * chart; that is the visible-and-harmless failure the rule asks for, as against
 * a chart of chords nobody is playing.
 */
function notesIn(path: string): { notes: BSV.ClipNote[]; problem?: string } {
  const clip = at(path);
  if (!exists(clip)) return { notes: [], problem: 'no clip at ' + path };
  // An audio clip has no notes and answering the call on one is an error, not
  // an empty list. Not a problem either — it is simply not a thing with chords.
  if (!gbool(clip, 'is_midi_clip')) return { notes: [] };

  let raw = '';
  try {
    const answer = clip.call('get_all_notes_extended');
    // **Every plausible shape, because this could not be checked on paper.**
    // Max's convention is that a dict-returning function answers with the
    // dict's name, but `call` has been seen to wrap that in an array and to
    // prefix it with the symbol `dictionary`. Rather than guess once and fail
    // silently, take the last atom that looks like a name and say what arrived
    // when none does.
    // Flatten whatever came back to a list of words, then take the last one
    // that is not the literal `dictionary`. That covers the three shapes this
    // has been seen to take — a bare name, `dictionary <name>` as **one symbol
    // with a space in it**, and the same pair as two atoms — and the middle one
    // is what was actually happening: `new Dict('dictionary u123')` does not
    // fail, it cheerfully creates a second, empty dictionary under that name,
    // which stringifies to `{}` and reads as a clip with no notes in it.
    const words = String(
      typeof answer === 'string' ? answer : (answer as unknown as unknown[]).join(' '),
    )
      .trim()
      .split(/\s+/)
      .filter((word) => word !== '' && word !== 'dictionary');
    const name = words.length > 0 ? words[words.length - 1]! : '';
    if (name === '') {
      const shape = typeof answer + ' ' + String(answer).substring(0, 120);
      post('bsv notes: no dict name in answer — ' + shape + '\n');
      return { notes: [], problem: 'no dict name in answer: ' + shape };
    }
    raw = new Dict(name).stringify();
    if (raw === '{}' || raw === '') {
      // Say what was asked for as well as what came back. An empty dict is
      // almost always the wrong name rather than an empty clip, and without the
      // name in hand there is no way to tell those apart.
      const shape = 'answer=' + String(answer).substring(0, 80) + ' name=' + name;
      post('bsv notes: empty dict — ' + shape + '\n');
      return { notes: [], problem: 'empty dict: ' + shape };
    }
  } catch (e) {
    post('bsv notes: could not read ' + path + ': ' + describe(e) + '\n');
    return { notes: [], problem: describe(e) };
  }

  let parsed: { notes?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    post('bsv notes: could not parse notes as JSON: ' + String(raw).substring(0, 200) + '\n');
    return { notes: [], problem: 'unparseable: ' + String(raw).substring(0, 120) };
  }

  const list = parsed && parsed.notes ? parsed.notes : null;
  if (!list || typeof (list as { length?: number }).length !== 'number') {
    post('bsv notes: no note list in ' + String(raw).substring(0, 200) + '\n');
    return { notes: [], problem: 'no note list: ' + String(raw).substring(0, 120) };
  }

  const rows = list as Array<Record<string, unknown>>;
  const out: BSV.ClipNote[] = [];
  for (let i = 0; i < rows.length && out.length < NOTE_COUNT_MAX; i++) {
    const note = rows[i];
    if (!note) continue;
    // A muted note does not sound, so it is not part of the harmony. Dropped
    // here rather than carried with a flag, so nothing downstream can forget.
    if (Number(note.mute) === 1) continue;
    const pitch = Number(note.pitch);
    const start = Number(note.start_time);
    const duration = Number(note.duration);
    if (!isFinite(pitch) || !isFinite(start) || !isFinite(duration)) continue;
    out.push({ pitch: pitch, start: start, duration: duration });
  }
  return { notes: out };
}

/**
 * The notes of every clip asked for, in one answer.
 *
 * Atoms in, dict out: the ask is a handful of numbers and the answer can be
 * thousands of notes. A slot holding nothing still gets an entry with an empty
 * list — a reader has to be able to tell "no notes here" from "you did not ask".
 */
function clip_notes(reqId: number, ...pairs: number[]): void {
  if (!deviceReady) return fail(reqId, 'device not ready');
  const t0 = Date.now();
  try {
    const clips: BSV.ClipNotes[] = [];
    const instruments: { [t: number]: string } = {};
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const t = Number(pairs[i]);
      const s = Number(pairs[i + 1]);
      if (!isFinite(t) || !isFinite(s) || t < 0 || s < 0) continue;
      // One read per *track*, not per clip: a scene's worth of clips is a
      // scene's worth of the same few tracks.
      if (instruments[t] === undefined) instruments[t] = instrumentOf(t);
      const read = notesIn('live_set tracks ' + t + ' clip_slots ' + s + ' clip');
      const row: BSV.ClipNotes = {
        t: t,
        s: s,
        instrument: instruments[t],
        notes: read.notes,
      };
      if (read.problem) row.problem = read.problem;
      clips.push(row);
    }
    publish(NOTES_DICT, { clips: clips });
    outlet(0, 'clip_notes_done', reqId, NOTES_DICT, Date.now() - t0);
  } catch (e) {
    fail(reqId, e);
  }
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

/**
 * Whether a read and a write would overlap, in either direction.
 *
 * The write paths have always refused each other. The snapshot joins them now
 * that it yields: a walk spread over ticks can have `apply` land in one of the
 * gaps, and the result describes neither the set before that write nor the one
 * after it. The guard runs both ways — a write during a walk is refused, and a
 * walk during a write is too.
 */
function blockedBy(): string | null {
  if (snapJob) return 'a snapshot is already in progress';
  if (job || moveJob || clipJob) return 'a write is already in progress';
  return null;
}

interface SnapshotJob {
  reqId: number;
  /** Wall clock from the first request, held across a restart. */
  t0: number;
  pass: 'tracks' | 'scenes' | 'slots' | 'clips';
  /** Cursor within the current pass. In `slots` it is the track half. */
  i: number;
  /** Scene cursor, `slots` pass only. */
  s: number;
  trackCount: number;
  sceneCount: number;
  masterColor: number | null;
  tracks: BSV.Track[];
  indexOfId: { [id: string]: number };
  parentIds: number[];
  scenes: BSV.Scene[];
  occupied: Array<[number, number]>;
  clips: BSV.Clip[];
  slotsScanned: number;
  slotTrackCount: number;
  slotTracksDone: number;
  /** LOM time per pass, excluding the gaps. See `newSnapshotJob`. */
  work: { tracks: number; scenes: number; slots: number; clips: number };
  /** Set by `onStructureChange`. The walk starts over rather than tearing. */
  stale: boolean;
  restarts: number;
  lastProgress: number;
}

var snapJob: SnapshotJob | null = null;

/**
 * Read what the walk needs before it can be chunked, and nothing else.
 *
 * The counts have to be taken once and held: every pass is indexed against
 * them, and re-reading `getcount` per tick would let a set that grew mid-walk
 * produce a snapshot with more scenes than the scene rows describe. If they
 * change, `stale` is the mechanism, not a fresh count.
 */
function newSnapshotJob(reqId: number, t0: number): SnapshotJob {
  const set = at('live_set');
  return {
    reqId: reqId,
    t0: t0,
    pass: 'tracks',
    i: 0,
    s: 0,
    trackCount: set.getcount('tracks'),
    sceneCount: set.getcount('scenes'),
    masterColor: readMasterColor(),
    tracks: [],
    indexOfId: {},
    parentIds: [],
    scenes: [],
    occupied: [],
    clips: [],
    slotsScanned: 0,
    slotTrackCount: 0,
    slotTracksDone: 0,
    work: { tracks: 0, scenes: 0, slots: 0, clips: 0 },
    stale: false,
    restarts: 0,
    lastProgress: -1,
  };
}

/**
 * The four passes do very different amounts of work, so raw item counts would
 * make the bar jump backwards when the next pass's total became known. Give
 * each pass a stable slice instead. Integer de-duplication also caps a large
 * set at 101 messages rather than one per scene and clip.
 */
function snapProgress(j: SnapshotJob, done: number): void {
  const next = Math.max(0, Math.min(100, Math.floor(done)));
  if (next === j.lastProgress) return;
  j.lastProgress = next;
  outlet(0, 'snapshot_progress', j.reqId, next, 100);
}

function snapPhase(
  j: SnapshotJob, start: number, span: number, done: number, total: number,
): void {
  snapProgress(j, total > 0 ? start + span * done / total : start + span);
}

function snapshotTracks(j: SnapshotJob): boolean {
  const end = Math.min(j.i + SNAP_CHUNK.tracks, j.trackCount);
  for (; j.i < end; j.i++) {
    const a = at('live_set tracks ' + j.i);
    const isGroup = gbool(a, 'is_foldable');
    j.indexOfId[String(a.id)] = j.i;
    j.parentIds.push(gbool(a, 'is_grouped') ? gid(a, 'group_track') : 0);
    j.tracks.push({
      i: j.i,
      name: gstr(a, 'name'),
      color: gnum(a, 'color'),
      colorIndex: gnum(a, 'color_index'),
      isMidi: gbool(a, 'has_midi_input'),
      isGroup: isGroup,
      isGrouped: gbool(a, 'is_grouped'),
      groupIndex: -1, // resolved once every id is known
      // fold_state is documented as only available when is_foldable, so don't
      // ask for it on a track that isn't a group.
      isFolded: isGroup ? gbool(a, 'fold_state') : false,
    });
  }
  return j.i >= j.trackCount;
}

/**
 * `group_track` hands back the parent's LOM id, but everything downstream
 * addresses tracks by index. A second pass is needed regardless of chunking: a
 * nested group's parent is itself a track, so only after every track has been
 * read are all the ids known.
 */
function resolveGroupParents(j: SnapshotJob): void {
  for (let t = 0; t < j.trackCount; t++) {
    if (!j.parentIds[t]) continue;
    const parent = j.indexOfId[String(j.parentIds[t])];
    if (parent !== undefined) j.tracks[t].groupIndex = parent;
  }
  j.slotTrackCount = j.tracks.reduce((n, track) => n + (track.isGroup ? 0 : 1), 0);
}

function snapshotScenes(j: SnapshotJob): boolean {
  const end = Math.min(j.i + SNAP_CHUNK.scenes, j.sceneCount);
  for (; j.i < end; j.i++) j.scenes.push(readSceneRow(j.i)!);
  return j.i >= j.sceneCount;
}

/**
 * The occupancy scan, which is most of the walk.
 *
 * Two passes on purpose, as before: this one is `trackCount x sceneCount` and
 * mostly empty slots, while the property reads below only touch clips that
 * exist — timing them separately is what says which one to attack.
 *
 * The budget is counted in *slots* and crosses track boundaries rather than
 * restarting at them, for the reason `applyStep` does the same: a track with
 * four scenes shouldn't cost a whole tick.
 *
 * Deliberately canonical paths. `goto('id N')` does not resolve under this v8
 * LiveAPI build; probing it once per track only emits `get: no valid object
 * set` before falling back to this same scan.
 */
function snapshotSlots(j: SnapshotJob): boolean {
  let budget = SNAP_CHUNK.slots;
  while (budget > 0) {
    if (j.i >= j.trackCount) break;
    // Group tracks have no real clip slots.
    if (j.tracks[j.i].isGroup) {
      j.i++;
      j.s = 0;
      continue;
    }
    if (j.s >= j.sceneCount) {
      j.i++;
      j.s = 0;
      j.slotTracksDone++;
      continue;
    }
    j.slotsScanned++;
    budget--;
    const slot = at('live_set tracks ' + j.i + ' clip_slots ' + j.s);
    if (exists(slot) && gbool(slot, 'has_clip')) {
      const c = at('live_set tracks ' + j.i + ' clip_slots ' + j.s + ' clip');
      if (exists(c)) j.occupied.push([j.i, j.s]);
    }
    j.s++;
  }
  return j.i >= j.trackCount;
}

function snapshotClips(j: SnapshotJob): boolean {
  const end = Math.min(j.i + SNAP_CHUNK.clips, j.occupied.length);
  for (; j.i < end; j.i++) {
    const t = j.occupied[j.i][0];
    const s = j.occupied[j.i][1];
    const c = at('live_set tracks ' + t + ' clip_slots ' + s + ' clip');
    if (!exists(c)) continue;
    j.clips.push({
      t: t,
      s: s,
      name: gstr(c, 'name'),
      colorIndex: gnum(c, 'color_index'),
      color: gnum(c, 'color'),
      length: gnum(c, 'length'),
      isMidi: gbool(c, 'is_midi_clip'),
    });
  }
  return j.i >= j.occupied.length;
}

/**
 * The walk, spread over scheduler ticks so Live's UI keeps breathing.
 *
 * It was one synchronous loop, which is why opening a large set froze Live for
 * the length of it. Every *write* in this file already chunks for exactly that
 * reason — `applyStep`, `moveStep`, `clipMoveStep` — and the read that costs
 * the most was the one place the idiom was skipped.
 *
 * **There is no other lever.** LiveAPI is main-thread-only, `Task` is a
 * scheduler on that same thread, and the Node half has no LiveAPI at all —
 * which is why `lom.ts` exists as a separate file in the first place. Yielding
 * is the whole toolbox; there is no worker to move this to.
 *
 * Chunking buys responsiveness and spends atomicity. A synchronous walk cannot
 * see the set change underneath it. This one can, and a walk that read tracks
 * before an insert and clips after it would describe a set that never existed —
 * silently, which is the failure mode this file is most careful about. So
 * `onStructureChange` marks the job stale and it starts over.
 */
function snapshotStep(): void {
  const j = snapJob;
  if (!j) {
    snapshotTask.cancel();
    return;
  }
  if (j.stale) return restartSnapshot(j);
  const tick = Date.now();
  try {
    if (j.pass === 'tracks') {
      const done = snapshotTracks(j);
      j.work.tracks += Date.now() - tick;
      snapPhase(j, 0, 10, j.i, j.trackCount);
      if (done) {
        resolveGroupParents(j);
        j.pass = 'scenes';
        j.i = 0;
      }
    } else if (j.pass === 'scenes') {
      const done = snapshotScenes(j);
      j.work.scenes += Date.now() - tick;
      snapPhase(j, 10, 10, j.i, j.sceneCount);
      if (done) {
        j.pass = 'slots';
        j.i = 0;
        j.s = 0;
      }
    } else if (j.pass === 'slots') {
      const done = snapshotSlots(j);
      j.work.slots += Date.now() - tick;
      snapPhase(j, 20, 60, j.slotTracksDone, j.slotTrackCount);
      if (done) {
        j.pass = 'clips';
        j.i = 0;
      }
    } else {
      const done = snapshotClips(j);
      j.work.clips += Date.now() - tick;
      snapPhase(j, 80, 18, j.i, j.occupied.length);
      if (done) finishSnapshot(j);
    }
  } catch (e) {
    snapshotTask.cancel();
    snapJob = null;
    fail(j.reqId, e);
  }
}

/**
 * Start over, because the set is no longer the one this walk began reading.
 *
 * The original request's clock is kept, so `elapsed` reports what the caller
 * actually waited rather than the length of the last attempt.
 */
function restartSnapshot(j: SnapshotJob): void {
  if (j.restarts >= SNAP_MAX_RESTARTS) {
    snapshotTask.cancel();
    snapJob = null;
    return fail(
      j.reqId,
      'the set kept changing while it was being read (' + SNAP_MAX_RESTARTS +
        ' restarts) — ask again once Live has settled',
    );
  }
  try {
    const next = newSnapshotJob(j.reqId, j.t0);
    next.restarts = j.restarts + 1;
    // Progress deliberately starts over with the walk rather than carrying the
    // old figure forward. The bar going backwards is honest — it *did* start
    // again — and holding the old number would show a walk sitting at 60% while
    // it re-reads the tracks.
    snapJob = next;
    post('bsv snapshot restarted: the set changed mid-walk (' + next.restarts + ')\n');
  } catch (e) {
    snapshotTask.cancel();
    snapJob = null;
    fail(j.reqId, e);
  }
}

function finishSnapshot(j: SnapshotJob): void {
  snapshotTask.cancel();
  // Free here — the walk has just read every clip in the set — and it is what
  // lets a scoped re-read afterwards tell "nothing changed" from "changed".
  seedDigests(j.trackCount, j.clips, j.scenes, j.tracks, j.masterColor);

  const work = j.work.tracks + j.work.scenes + j.work.slots + j.work.clips;
  const payload: BSV.Snapshot = {
    // Shares the sequence with deltas, so a client can tell a delta that
    // follows what it holds from one that skipped a step.
    rev: nextRev(),
    ms: work,
    timings: {
      tracks: j.work.tracks,
      scenes: j.work.scenes,
      slots: j.work.slots,
      clips: j.work.clips,
      slotsScanned: j.slotsScanned,
      elapsed: Date.now() - j.t0,
      restarts: j.restarts,
    },
    tempo: gnum(at('live_set'), 'tempo'),
    masterColor: j.masterColor,
    trackCount: j.trackCount,
    sceneCount: j.sceneCount,
    clipCount: j.clips.length,
    tracks: j.tracks,
    scenes: j.scenes,
    clips: j.clips,
  };

  const tDict = Date.now();
  snapProgress(j, 99);
  publish(SNAPSHOT_DICT, payload);
  snapProgress(j, 100);
  // Cleared after the publish, not before — `snapJob` is the guard keeping
  // writes and delta flushes out while this runs, and clearing it first would
  // reopen that window across the two calls above. Same bargain `finishJob`
  // makes, for the same reason.
  snapJob = null;
  outlet(0, 'snapshot_done', j.reqId, SNAPSHOT_DICT, Date.now() - tDict);
}

var snapshotTask = new Task(snapshotStep);
snapshotTask.interval = SNAP_INTERVAL_MS;

function snapshot(reqId: number): void {
  if (!deviceReady) return fail(reqId, 'device not ready');
  if (snapJob) return fail(reqId, 'a snapshot is already in progress');
  // A walk of a half-written set describes neither the set before the write nor
  // the one after it. The write paths refuse for the mirror-image reason.
  const busyWith = blockedBy();
  if (busyWith) return fail(reqId, busyWith);
  try {
    snapJob = newSnapshotJob(reqId, Date.now());
  } catch (e) {
    return fail(reqId, e);
  }
  snapProgress(snapJob, 0);
  snapshotTask.repeat();
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
  const busyWith = blockedBy();
  if (busyWith) return fail(reqId, busyWith);
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
  const busyWith = blockedBy();
  if (busyWith) return fail(reqId, busyWith);
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
    structuralJob = true;
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
      structureSettleTask.cancel();
      structureSettleTask.schedule(100);
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

var structureSettleTask = new Task(function () {
  structuralJob = false;
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
  publish(RESULT_DICT, result);
  outlet(0, 'apply_done', j.reqId, RESULT_DICT, ms);
  // Cleared **after** the publish, not before. `job` is the guard that keeps a
  // second writer and a delta flush out while this one is running, and clearing
  // it first reopened that window across the two calls above — long enough for a
  // flush to compute a delta against a set whose result hadn't been staged yet.
  job = null;
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
  const busyWith = blockedBy();
  if (busyWith) return fail(reqId, busyWith);
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

    // A reorder is a build-then-delete pass, so it trips the scenes observer
    // once per scene created and once per scene deleted. Mute the burst for the
    // duration; `finishMove` releases it and Node emits the one event that
    // matters. Set before the first `create_scene`, not after.
    structuralJob = true;
    structureSettleTask.cancel();

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
    // The mute is set just above, so a throw between there and `repeat()` would
    // leave it on for the rest of the session — and a stuck mute means no client
    // is ever told the set restructured again. Silent, and permanent.
    structuralJob = false;
    structureSettleTask.cancel();
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
  // Same trailing-callback allowance as add_scenes: Live may deliver the last
  // scenes-observer callbacks just after the final delete returns, so the mute
  // outlives the job by a beat rather than ending with it.
  structureSettleTask.cancel();
  structureSettleTask.schedule(100);
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
  const busyWith = blockedBy();
  if (busyWith) return fail(reqId, busyWith);
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
        const sc = at('live_set scenes ' + i);
        if (!exists(sc)) return;
        // Live *selects* the scene as a side effect of firing it, which used to
        // be a curiosity and is now a cost: moving the cursor tears down and
        // rebuilds the cursor observers and re-reads a track, on every launch —
        // during a show. `fire(force_legato, can_select_scene_on_launch)` is in
        // 12.4.3's own docstring table and `0` for the second suppresses it.
        //
        // Unverified through Max's `call()`, so the one-argument form stays as
        // the fallback. Firing the scene is what matters; not moving the cursor
        // is an optimisation, and it must not be able to cost a launch.
        try {
          sc.call('fire', 0, 0);
        } catch (e) {
          sc.call('fire');
        }
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

// --- Session selection ------------------------------------------------
// Select one exact scene and let Live reveal it in Session View. The LOM's
// `selected_scene` takes a Scene object, not an index, so resolve the runtime id
// first. Measured in Live 12.4.3: assigning it centers the scene visually.

function setSelectedScene(index: number): number {
  const sceneIndex = Number(index);
  const sceneCount = at('live_set').getcount('scenes');
  if (
    !isFinite(sceneIndex) ||
    Math.floor(sceneIndex) !== sceneIndex ||
    sceneIndex < 0 ||
    sceneIndex >= sceneCount
  ) {
    throw new Error(
      'scene index ' + index + ' is outside 0–' + Math.max(0, sceneCount - 1),
    );
  }

  const scene = at('live_set scenes ' + sceneIndex);
  if (!exists(scene)) throw new Error('scene ' + sceneIndex + ' did not resolve');
  const sceneId = Number(scene.id);

  // at() is one reusable cursor: capture the id before pointing it back at
  // Song.View to set the object-valued child.
  at('live_set view').set('selected_scene', 'id', sceneId);
  return sceneId;
}

function select_scene(index: number): void {
  if (!deviceReady) return fail(-1, 'device not ready');
  try {
    setSelectedScene(index);
  } catch (e) {
    fail(-1, e);
  }
}

// The same move along the other axis, and the reason it exists is the device
// chain: Live's device view shows the *selected track's* devices, so a footer
// in this app showing one track and Live showing another is two answers to one
// question. `selected_track` takes a Track object rather than an index, exactly
// like `selected_scene`.

function setSelectedTrack(index: number): number {
  const trackIndex = Number(index);
  const trackCount = at('live_set').getcount('tracks');
  if (
    !isFinite(trackIndex) ||
    Math.floor(trackIndex) !== trackIndex ||
    trackIndex < 0 ||
    trackIndex >= trackCount
  ) {
    throw new Error(
      'track index ' + index + ' is outside 0–' + Math.max(0, trackCount - 1),
    );
  }

  const track = at('live_set tracks ' + trackIndex);
  if (!exists(track)) throw new Error('track ' + trackIndex + ' did not resolve');
  const trackId = Number(track.id);

  at('live_set view').set('selected_track', 'id', trackId);
  return trackId;
}

function select_track(index: number): void {
  if (!deviceReady) return fail(-1, 'device not ready');
  try {
    setSelectedTrack(index);
  } catch (e) {
    fail(-1, e);
  }
}

// --- device chain -----------------------------------------------------
// One track's devices, as much of each as a shell can draw: its name, whether
// it is on, whether it is folded, and a rack's chains. No parameters — see
// `ChainDevice` in the protocol for why that is a later field rather than a
// later redesign.
//
// **`at()` is one cursor**, and this is the deepest recursion in the file, so
// the rule matters more here than anywhere: every scalar comes off a device
// before anything reads its chains, because the next `at()` re-points the same
// object out from under the caller.
//
// **Nothing here recurses any more.** It used to: the one-shot read walked
// every chain of every rack in one answer, which is why it needed a depth
// floor. A run is now read alone and a rack's chains are a list of names, so
// depth is bounded at one by construction rather than by a guard — and a chain
// a client opens is a subscription of its own. See `readWatchedRun`.

/** More devices than this in one run is a bad answer, not a big set. */
const DEVICE_COUNT_MAX = 64;

function readChainDevice(path: string): BSV.ChainDevice | null {
  const device = at(path);
  if (!exists(device)) return null;

  // Every scalar off this object first — `at()` below re-points the cursor.
  const name = gstr(device, 'name');
  const className = gstr(device, 'class_name');
  const on = gbool(device, 'is_active');

  // Its own child object, so it costs a second goto. A device whose view does
  // not resolve is drawn open rather than skipped: an unreadable fold state is
  // no reason to hide a device that is plainly there.
  const view = at(path + ' view');
  const folded = exists(view) ? gbool(view, 'is_collapsed') : false;

  // `chains` is deliberately not set here. Whether this device is a rack, and
  // what its chains are called, is `readWatchedRun`'s to fill in — it is the
  // one that knows a run is being read for a subscription rather than walked.
  return { name: name, className: className, on: on, folded: folded };
}

/**
 * The devices hanging off one holder — a track, or a chain inside a rack. Both
 * expose the same `devices` child list, which is why a chain reads exactly like
 * a track does.
 */
function readDeviceRun(path: string): BSV.ChainDevice[] {
  let count = 0;
  try {
    count = at(path).getcount('devices');
  } catch (e) {
    post('bsv devices: devices unavailable at ' + path + ': ' + describe(e) + '\n');
    return [];
  }
  const limit = Math.min(count, DEVICE_COUNT_MAX);
  if (count > limit) {
    post('bsv devices: ' + count + ' devices at ' + path + ', reading ' + limit + '\n');
  }
  const devices: BSV.ChainDevice[] = [];
  for (let i = 0; i < limit; i++) {
    const device = readChainDevice(path + ' devices ' + i);
    if (device) devices.push(device);
  }
  return devices;
}


// --- device-chain watch -----------------------------------------------
//
// The first watch in this file with a *target*.
//
// Every other one is armed by a boolean, because its cost doesn't depend on
// what it is watching: `watch_play` installs the same observers whoever asked.
// This one's cost is entirely a function of which runs are on screen, so the
// bridge unions what every client declared (`core/src/chainWatch.ts`) and sends
// the union here. This side never sees clients, only the answer.
//
// **Shells only, for now.** Name, activator and fold state per device, plus the
// run's own membership — which is what turns the old `devices` read into
// something that notices a device added in Live. Parameters are the next tier
// and land as a field on what this publishes, not as a redesign of it.
//
// The callbacks infer nothing. Any of them marks the whole thing dirty and a
// `Task` re-reads every watched run, exactly as the cursor watcher does: a
// re-read answers the same question whichever property fired, and inference is
// what this file keeps out. It is also the only legal shape — Live throws
// `Changes cannot be triggered by notifications` on a write from inside a
// callback, and re-attaching observers is close enough to that line to keep off
// it entirely.

/**
 * Runaway stop across shells *and* parameters.
 *
 * Shells are three observers a device; an open device is one more per control,
 * which is ~40 for an EQ Eight. So this is ~130 devices closed, or a handful
 * open — and `rebuildChainObservers` attaches every shell before any parameter
 * precisely so that hitting it costs knobs rather than the chain itself.
 */
const CHAIN_OBSERVER_MAX = 400;

/** More controls than this on one device is a bad answer, not a big device. */
const PARAM_COUNT_MAX = 128;

/**
 * How many members of a quantized parameter are spelled out.
 *
 * Each one costs a `str_for_value` call, and past a certain width the list
 * stops being something a `Select` can show anyway — a 128-value MIDI note
 * parameter is a number box, not a menu. Beyond this the members are omitted
 * and the control falls back to the current value's `display`.
 */
const PARAM_ITEMS_MAX = 64;

/** Coalesce a drag into one message a frame rather than one per callback. */
const PARAM_DEBOUNCE_MS = 30;

var chainWatches: BSV.ChainWatch[] = [];
var chainObservers: LiveAPI[] = [];
var chainWatching = false;
var lastChainKey = '';

/**
 * What the observers currently point at. See `chainShapeKey`.
 */
var lastChainShape = '';

/**
 * True while observers are being attached or detached, so this file's own
 * callbacks can't schedule the very rebuild that is running.
 *
 * **Constructing a `LiveAPI` calls its callback synchronously**, with
 * `['id', N]`, before the observed property has ever reported. This file
 * already records that where it first bit: `meterValue` refuses that frame
 * because reading it as a level put every track at full scale.
 *
 * Here it is worse than a wrong reading. `onChainChange` deliberately infers
 * nothing from its arguments — any callback means "re-read everything" — so an
 * attach-time callback schedules `chainTask`, which rebuilds, which attaches,
 * which schedules `chainTask`. That is a 60ms loop constructing several
 * hundred `LiveAPI` objects a turn, on the thread that draws Live, for as long
 * as anything is being watched. It does not converge and it does not stop.
 */
var chainAttaching = false;

/**
 * The LOM path of the run a watch names, or null if it no longer resolves.
 *
 * `path` is **pairs** — a run inside a rack is `devices M chains L`, and that
 * chain's own `devices` is the run. An odd length names half an address, which
 * is a malformed subscription rather than a shorter one.
 */
function runPathOf(t: number, steps: readonly number[]): string {
  let path = 'live_set tracks ' + t;
  for (let i = 0; i < steps.length; i += 2) {
    path += ' devices ' + steps[i] + ' chains ' + steps[i + 1];
  }
  return path;
}

/**
 * The same address, resolved a step at a time so a stale one fails early.
 *
 * `runPathOf` builds the string; this one insists every hop of it is really
 * there. That matters because a path is a *position*: a rack deleted in Live
 * leaves every path past it naming some other device, and the difference
 * between "no longer resolves" and "resolves to the wrong thing" is the
 * difference between a run reported gone and a write landing on a stranger.
 */
function resolveRunPath(t: number, steps: readonly number[]): string | null {
  if (steps.length % 2 !== 0) return null;
  let path = 'live_set tracks ' + t;
  if (!exists(at(path))) return null;
  for (let i = 0; i < steps.length; i += 2) {
    path += ' devices ' + steps[i] + ' chains ' + steps[i + 1];
    if (!exists(at(path))) return null;
  }
  return path;
}

function chainRunPath(w: BSV.ChainWatch): string | null {
  return resolveRunPath(w.t, w.path || []);
}

/**
 * Every control on one device.
 *
 * Read whole when the device opens, because all of it except `value`, `display`
 * and `state` is fixed for as long as the device exists. That is the trade the
 * whole tier rests on: one read of ~7 properties per control up front, then one
 * observer per control forever after, rather than re-reading to find out what
 * moved.
 */
/**
 * Descriptors already read, keyed by the device that owns them.
 *
 * **This is what makes "read once" true.** Everything about a control except
 * `value`, `display` and `state` is fixed for as long as the device exists —
 * its name, its range, whether it is quantized, and the members it steps
 * through. The read below used to fetch all of it on every structural push, so
 * *renaming one device* re-read every control on every open device in the run
 * and re-spelled every enum's members with it. An EQ Eight is ~90 controls and
 * a quantized one costs a `str_for_value` call per member, which put a single
 * open device at ~800 LOM operations per push, on the thread that draws Live.
 *
 * The key is the device's LOM id **and** its control count. The id alone is
 * wrong for a plugin whose parameter list changes underneath it; the count
 * alone is wrong for a device swapped for another with as many controls.
 *
 * Entries live across observer rebuilds — opening a fourth device must not
 * re-read the three already open, which is precisely the gesture that hurt.
 * They are evicted by not being used: `sendChainState` keeps only what it
 * touched, so a device that folds shut drops its descriptor with everything
 * else it was costing.
 */
var paramShapes: { [key: string]: BSV.DeviceParameterState[] } = {};
var paramShapesUsed: { [key: string]: BSV.DeviceParameterState[] } = {};

/**
 * Every control on one device.
 *
 * `cacheable` is false for a rack, and that carve-out is not about cost — a
 * rack has a handful of macros where an EQ has ninety. It is that a rack's
 * chain selector spells its members as the *chain names*, so renaming a chain
 * changes an enum's text without changing its parameter count. Re-reading the
 * one device whose members are genuinely dynamic is cheaper than a cache key
 * that could tell.
 */
function readDeviceParameters(
  devicePath: string,
  cacheable: boolean,
): BSV.DeviceParameterState[] {
  let count = 0;
  try {
    count = at(devicePath).getcount('parameters');
  } catch (e) {
    post('bsv params: unavailable at ' + devicePath + ': ' + describe(e) + '\n');
    return [];
  }
  const limit = Math.min(count, PARAM_COUNT_MAX);
  if (count > limit) {
    post('bsv params: ' + count + ' at ' + devicePath + ', reading ' + limit + '\n');
  }

  let key = '';
  if (cacheable) {
    const device = at(devicePath);
    key = (exists(device) ? String(device.id) : devicePath) + ':' + limit;
    const held = paramShapes[key];
    if (held && held.length === limit) {
      refreshParameterValues(devicePath, held);
      paramShapesUsed[key] = held;
      return held;
    }
  }

  const parameters = readParameterShapes(devicePath, limit);
  if (cacheable) paramShapesUsed[key] = parameters;
  return parameters;
}

/** The whole descriptor, read fresh. Called once per device, then cached. */
function readParameterShapes(
  devicePath: string,
  limit: number,
): BSV.DeviceParameterState[] {
  const parameters: BSV.DeviceParameterState[] = [];
  for (let i = 0; i < limit; i++) {
    const parameter = at(devicePath + ' parameters ' + i);
    if (!exists(parameter)) {
      // **Index-aligned on purpose.** `p` on the wire is the LOM's own index —
      // it is what the value observers report and what `set_device` writes
      // against — so dropping an entry here would slide every control after it
      // onto the wrong parameter, silently and only on the devices where one
      // failed to resolve. A dead entry is refused by `paramDisabled`.
      parameters.push({
        name: '', value: 0, min: 0, max: 1, quantized: false, display: '', state: 2,
      });
      continue;
    }
    // Every scalar off this cursor before anything else calls `at()`.
    const name = gstr(parameter, 'name');
    const value = gnum(parameter, 'value');
    const min = gnum(parameter, 'min');
    const max = gnum(parameter, 'max');
    const quantized = gbool(parameter, 'is_quantized');
    const state = gnumOr(parameter, 'state', 0);
    const entry: BSV.DeviceParameterState = {
      name: name,
      value: value,
      min: min,
      max: max,
      quantized: quantized,
      display: parameterDisplay(parameter, value),
      state: state,
    };
    if (quantized) {
      const items = parameterItems(parameter, min, max);
      if (items.length > 0) entry.items = items;
    } else {
      // Live exposes a default only for continuous parameters. Asking a
      // quantized one answers nothing useful, so don't claim it has a reset.
      entry.defaultValue = gnumOr(parameter, 'default_value', value);
    }
    parameters.push(entry);
  }
  return parameters;
}

/**
 * The three fields that move, refreshed onto a descriptor we already hold.
 *
 * Two `get`s and one `call` per control, against nine-plus and a call per enum
 * member for the full read. Mutated in place rather than copied because the
 * result is serialised immediately and nothing else holds a reference — the
 * array *is* the cache entry.
 *
 * `state` is here rather than observed, which is the trade
 * `attachParamObservers` describes: it moves when a parameter becomes
 * macro-controlled or automation is armed, roughly never mid-set, so it rides
 * the structural push instead of doubling the observer budget.
 */
function refreshParameterValues(
  devicePath: string,
  parameters: BSV.DeviceParameterState[],
): void {
  for (let i = 0; i < parameters.length; i++) {
    const parameter = at(devicePath + ' parameters ' + i);
    if (!exists(parameter)) continue;
    const value = gnum(parameter, 'value');
    parameters[i].value = value;
    parameters[i].state = gnumOr(parameter, 'state', 0);
    // Last, because it `call`s on the same cursor every `get` above used.
    parameters[i].display = parameterDisplay(parameter, value);
  }
}

/**
 * The members of a quantized parameter, spelled by Live.
 *
 * **Not `value_items`, and that is the point.** The property exists and looks
 * like the obvious answer, but it comes back as Max atoms — so a member whose
 * name contains a space arrives as two of them, and the list reads correctly
 * when joined while being the wrong *length*. `diag param` exists partly
 * because of that trap, and the length is exactly what an enum indexes by.
 *
 * `str_for_value` has no such problem: it is one call per member, it returns
 * that member's text and nothing else, and it is the same function every other
 * readout in this project already trusts to spell a value. It costs n calls
 * instead of one, once, when a device opens.
 */
function parameterItems(parameter: LiveAPI, min: number, max: number): string[] {
  const span = Math.round(max - min);
  if (!isFinite(span) || span < 1 || span + 1 > PARAM_ITEMS_MAX) return [];
  const items: string[] = [];
  for (let i = 0; i <= span; i++) {
    items.push(parameterDisplay(parameter, min + i));
  }
  return items;
}

/**
 * One watched run: its devices, and for a rack its chain *names* only.
 *
 * **It does not descend, and that is the whole subscription model.** The
 * one-shot read this replaced walked every chain of every rack, which meant the
 * footer drew devices nothing was observing — a device added inside a rack chain
 * was invisible until something asked again. Following them all instead is the
 * cost this design exists to avoid: a rack with eight chains of five devices is
 * 120 observers for one closed rack nobody is looking into.
 *
 * So a rack reports what it takes to draw its chain list, and the chain a client
 * actually opens is a subscription of its own — `path` naming it. What is
 * watched is then exactly what is on screen, which is the property the whole
 * scheme is for.
 */
function readWatchedRun(path: string, open: readonly number[]): BSV.ChainDevice[] {
  const devices = readDeviceRun(path);
  for (let i = 0; i < devices.length; i++) {
    const device = devices[i];
    const devicePath = path + ' devices ' + i;
    const rack = gbool(at(devicePath), 'can_have_chains');
    if (rack) {
      device.chains = readChainNames(devicePath);
    }
    // Parameters only for what someone has expanded. A closed device is a title
    // bar, and forty reads plus forty observers is what it costs not to be.
    if (open.indexOf(i) !== -1) {
      device.parameters = readDeviceParameters(devicePath, !rack);
    }
  }
  return devices;
}

/**
 * A rack's chains, as a list to pick from — no devices.
 *
 * `devices` is left absent rather than empty, because those mean different
 * things here: absent is "nobody is subscribed to this chain", empty is "this
 * chain is genuinely bare". A client that drew the empty case for the first
 * would show every unopened rack as containing nothing.
 */
function readChainNames(path: string): BSV.RackChain[] {
  let count = 0;
  try {
    count = at(path).getcount('chains');
  } catch (e) {
    post('bsv chains: unavailable at ' + path + ': ' + describe(e) + '\n');
    return [];
  }
  const chains: BSV.RackChain[] = [];
  for (let i = 0; i < count; i++) {
    const chain = at(path + ' chains ' + i);
    if (!exists(chain)) continue;
    chains.push({ name: gstr(chain, 'name') });
  }
  return chains;
}

/**
 * Re-read every watched run and publish, if anything actually moved.
 *
 * A run that no longer resolves is reported as `devices: null` rather than
 * omitted or empty. Those three mean different things to a client — gone,
 * unknown, and genuinely has no devices — and collapsing them is how a rack
 * that was deleted goes on being drawn.
 */
function sendChainState(): void {
  if (!chainWatching) return;
  // Descriptors survive this pass only if this pass used them — see
  // `paramShapes`. A device that folds shut, or a run that stops being watched,
  // drops its cached controls along with everything else it was costing.
  paramShapesUsed = {};
  const chains: BSV.WatchedChain[] = [];
  for (let i = 0; i < chainWatches.length; i++) {
    const w = chainWatches[i];
    const path = chainRunPath(w);
    chains.push({
      t: w.t,
      path: w.path,
      devices: path === null ? null : readWatchedRun(path, w.open || []),
    });
  }
  paramShapes = paramShapesUsed;
  const state: BSV.ChainState = { chains: chains };
  const key = JSON.stringify(state);
  if (key === lastChainKey) return;
  lastChainKey = key;
  outlet(0, 'chain_state', encodeMaxAtom(state));
}

var chainTask = new Task(function () {
  // Observers are path-addressed, so a device inserted into a run re-points
  // every one after it. Rebuild before reading rather than after: the read is
  // what publishes, and publishing against observers that describe the old
  // shape means the *next* change goes unheard.
  rebuildChainObservers();
  sendChainState();
});

function onChainChange(): void {
  if (!chainWatching || chainAttaching) return;
  chainTask.cancel();
  chainTask.schedule(CHAIN_DEBOUNCE_MS);
}

function addChainObserver(path: string, property: string): void {
  if (chainObservers.length >= CHAIN_OBSERVER_MAX) return;
  const observer = observeAt(path, property, onChainChange);
  if (observer) chainObservers.push(observer);
}

/**
 * One run's observers: the holder's membership, then per device the three
 * things a shell draws.
 *
 * `is_collapsed` is observable — this file recorded it as `get, set` for a
 * while, which is what a trimmed LOM table cost. See `bridge/LOM.md`.
 */
function attachChainObservers(path: string): void {
  addChainObserver(path, 'devices');
  let count = 0;
  try {
    count = at(path).getcount('devices');
  } catch (e) {
    return;
  }
  const limit = Math.min(count, DEVICE_COUNT_MAX);
  for (let i = 0; i < limit; i++) {
    const devicePath = path + ' devices ' + i;
    if (!exists(at(devicePath))) continue;
    addChainObserver(devicePath, 'name');
    addChainObserver(devicePath, 'is_active');
    addChainObserver(devicePath + ' view', 'is_collapsed');
    // A rack's chain *list* is drawn here, so it is followed here. What is
    // inside those chains is not — that is a subscription of its own, and the
    // client makes it when it opens one.
    if (gbool(at(devicePath), 'can_have_chains')) addChainObserver(devicePath, 'chains');
  }
}

/**
 * One `value` observer per control on every open device.
 *
 * **`value` only.** `state` is observable too and is deliberately not watched:
 * it moves when a parameter becomes macro-controlled or automation is armed —
 * roughly never, in the middle of a set — and watching it would double the
 * budget of the most expensive tier here. It rides the structural re-read
 * instead, so a control greys out on the next chain change rather than
 * instantly. `automation_state` is the same trade.
 */
function attachParamObservers(w: BSV.ChainWatch, runPath: string): void {
  const open = w.open || [];
  for (let k = 0; k < open.length; k++) {
    const i = open[k];
    const devicePath = runPath + ' devices ' + i;
    if (!exists(at(devicePath))) continue;
    let count = 0;
    try {
      count = at(devicePath).getcount('parameters');
    } catch (e) {
      continue;
    }
    const limit = Math.min(count, PARAM_COUNT_MAX);
    for (let index = 0; index < limit; index++) {
      addParamObserver(w.t, w.path, i, index, devicePath + ' parameters ' + index);
    }
  }
}

function addParamObserver(
  t: number, path: readonly number[], i: number, index: number, parameterPath: string,
): void {
  if (chainObservers.length >= CHAIN_OBSERVER_MAX) return;
  const observer = new LiveAPI(
    function (args: unknown[]) { onParamChange(t, path, i, index, args); },
    parameterPath,
  );
  if (!exists(observer)) return;
  observer.property = 'value';
  chainObservers.push(observer);
}

/**
 * A control moved. Record where and what, and flush on the next tick.
 *
 * `display` is left empty here on purpose. Spelling it costs a `str_for_value`
 * call, and during a drag this fires many times between flushes — so the text
 * is worked out once per parameter per *frame* rather than once per callback,
 * against whichever value survived to the flush.
 */
function onParamChange(
  t: number, path: readonly number[], i: number, index: number, args: unknown[],
): void {
  if (!chainWatching || chainAttaching) return;
  const value = mixerValue(args, 'value');
  if (value === null) return;
  paramDirty[t + '|' + path.join('.') + '|' + i + '|' + index] = {
    t: t,
    path: path as number[],
    i: i,
    p: index,
    value: value,
    display: '',
  };
  // A fixed-rate flush, not a debounce. Re-scheduling on every callback would
  // mean a knob held still mid-drag never reports until the drag *ends*, which
  // is the one moment its value is least interesting.
  if (paramPending) return;
  paramPending = true;
  paramTask.schedule(PARAM_DEBOUNCE_MS);
}

var paramDirty: { [key: string]: BSV.ChainValueChange } = {};
var paramPending = false;

var paramTask = new Task(function () {
  paramPending = false;
  const keys = Object.keys(paramDirty);
  const changes: BSV.ChainValueChange[] = [];
  for (let k = 0; k < keys.length; k++) {
    const change = paramDirty[keys[k]];
    const parameter = at(
      runPathOf(change.t, change.path) + ' devices ' + change.i + ' parameters ' + change.p,
    );
    change.display = exists(parameter) ? parameterDisplay(parameter, change.value) : '';
    changes.push(change);
  }
  paramDirty = {};
  if (!chainWatching || changes.length === 0) return;
  outlet(0, 'chain_values', encodeMaxAtom({ changes: changes }));
});

/**
 * What the observers are attached *to*, as one string.
 *
 * Only the facts that decide where an observer points: whether each run still
 * resolves, which devices are in it — by **id**, so a device swapped for
 * another at the same index counts as a move — which of them are open, and how
 * many controls each open one has.
 *
 * Deliberately not names, activators or fold state. Those are what the
 * observers *report*, and re-attaching several hundred of them because a device
 * was renamed is work that changes nothing about what is being watched. The
 * distinction is the whole point of the guard: `onChainChange` fires for every
 * one of those, and almost none of them move an observer.
 *
 * Reads through `at()`, which reuses one cursor and observes nothing, so
 * measuring the shape cannot itself trigger a callback.
 */
function chainShapeKey(): string {
  const parts: string[] = [];
  for (let i = 0; i < chainWatches.length; i++) {
    const w = chainWatches[i];
    const where = w.t + '|' + (w.path || []).join('.');
    const runPath = chainRunPath(w);
    if (runPath === null) {
      parts.push(where + '|gone');
      continue;
    }
    let count = -1;
    try {
      count = at(runPath).getcount('devices');
    } catch (e) {
      count = -1;
    }
    const limit = Math.min(Math.max(count, 0), DEVICE_COUNT_MAX);
    const ids: string[] = [];
    for (let k = 0; k < limit; k++) {
      const device = at(runPath + ' devices ' + k);
      ids.push(exists(device) ? String(device.id) : '-');
    }
    const open = w.open || [];
    const widths: string[] = [];
    for (let k = 0; k < open.length; k++) {
      let n = -1;
      try {
        n = at(runPath + ' devices ' + open[k]).getcount('parameters');
      } catch (e) {
        n = -1;
      }
      widths.push(open[k] + ':' + n);
    }
    parts.push(where + '|' + count + '|' + ids.join(',') + '|' + widths.join(','));
  }
  return parts.join(';');
}

function rebuildChainObservers(): void {
  if (!chainWatching) {
    clearChainObservers();
    paramDirty = {};
    lastChainShape = '';
    return;
  }

  // **Same targets means the observers already point at them.** The guard
  // `rebuildCursorObservers` makes, for the same reason and against a bigger
  // bill: every callback in this tier means "re-read everything", so without
  // it a device renamed in Live tears down and rebuilds up to four hundred
  // LiveAPI objects to end up observing exactly what it was already observing.
  const shape = chainShapeKey();
  if (shape === lastChainShape && chainObservers.length > 0) return;
  lastChainShape = shape;

  chainAttaching = true;
  try {
    clearChainObservers();
    // Indexes just moved under us, so anything queued describes a parameter
    // that may no longer be the one it names.
    paramDirty = {};
    // **Shells for every run first, then parameters.** Both draw on one budget,
    // and a chain that silently stopped updating is a worse failure than a knob
    // that did — so when the cap bites, it takes knobs.
    const paths: Array<string | null> = [];
    for (let i = 0; i < chainWatches.length; i++) {
      const path = chainRunPath(chainWatches[i]);
      paths.push(path);
      if (path !== null) attachChainObservers(path);
    }
    for (let i = 0; i < chainWatches.length; i++) {
      const path = paths[i];
      if (path !== null) attachParamObservers(chainWatches[i], path);
    }
  } finally {
    // Restored even if a path raised mid-attach. Leaving it set would mean the
    // watch never hears from Live again, which is the one failure worse than
    // rebuilding too often.
    chainAttaching = false;
  }

  if (chainObservers.length >= CHAIN_OBSERVER_MAX) {
    post(
      'bsv chains: hit the ' + CHAIN_OBSERVER_MAX + '-observer cap; ' +
        'some controls will not follow Live\n',
    );
  }
}

/**
 * Detaching can call back too, so this holds the flag as well — and saves the
 * old value rather than clearing it, because `rebuildChainObservers` calls this
 * from inside its own attaching window.
 */
function clearChainObservers(): void {
  const was = chainAttaching;
  chainAttaching = true;
  for (let i = 0; i < chainObservers.length; i++) {
    try {
      chainObservers[i].property = '';
    } catch (e) {
      /* object may already be gone */
    }
  }
  chainObservers = [];
  chainAttaching = was;
}

/**
 * The union, whole. Not a subscribe or an unsubscribe — this side is told what
 * is being looked at and rebuilds to match, so an empty list is how it stops.
 *
 * Rebuilding unconditionally rather than diffing is the same bargain
 * `watch_play` makes: the bridge already suppresses an unchanged union, so
 * anything arriving here is a real change, and a diff would be bookkeeping in
 * the file with no test coverage.
 */
function watch_chains(encoded: unknown): void {
  const decoded = decodeMaxAtom(encoded);
  const list = Array.isArray(decoded) ? (decoded as BSV.ChainWatch[]) : [];
  chainWatches = list;
  chainWatching = list.length > 0;
  lastChainKey = '';
  // A new declaration re-attaches unconditionally: the shape guard exists to
  // suppress Live's own chatter, not to second-guess what a client asked for.
  lastChainShape = '';
  paramShapes = {};
  chainTask.cancel();
  paramTask.cancel();
  paramPending = false;
  paramDirty = {};
  if (!chainWatching) {
    clearChainObservers();
    return;
  }
  rebuildChainObservers();
  sendChainState();
}

// --- device writes ----------------------------------------------------
// The other direction of the device chain: the activator, the fold triangle
// and every control on an open device.
//
// **Nothing here replies.** All three fields are already observed by the watch
// above — `is_active` and `is_collapsed` on the shell, `value` on each control
// — so the acknowledgement is the next `chain_state` or `chain_values`, and it
// is the same one another client's write produces. Confirming a `set()` here
// would be reporting that we called Live, which is the less useful fact.
//
// No undo step, following `set_mixer`. Turning a knob is not an edit anyone
// expects on ⌘Z as its own entry, and Live keeps its own automation history.

function deviceTargetPath(target: BSV.DeviceTarget): string | null {
  const steps = target.path || [];
  for (let i = 0; i < steps.length; i++) {
    if (!isFinite(steps[i]) || Math.floor(steps[i]) !== steps[i] || steps[i] < 0) return null;
  }
  const run = resolveRunPath(target.t, steps);
  if (run === null) return null;
  const path = run + ' devices ' + target.i;
  return exists(at(path)) ? path : null;
}

function set_device(encoded: unknown): void {
  if (!deviceReady) return fail(-1, 'device not ready');
  const value = decodeMaxAtom(encoded);
  if (!value || typeof value !== 'object') return fail(-1, 'malformed device write');
  const source = value as { target?: BSV.DeviceTarget; patch?: BSV.DevicePatch };
  const target = source.target;
  const patch = source.patch;
  const has = Object.prototype.hasOwnProperty;

  if (
    !target || !isFinite(target.t) || Math.floor(target.t) !== target.t || target.t < 0 ||
    !Array.isArray(target.path) || target.path.length % 2 !== 0 ||
    !isFinite(target.i) || Math.floor(target.i) !== target.i || target.i < 0
  ) {
    return fail(-1, 'invalid device target');
  }
  if (!patch || typeof patch !== 'object') return fail(-1, 'device patch is missing');
  if (has.call(patch, 'on') && typeof patch.on !== 'boolean') {
    return fail(-1, 'on must be boolean');
  }
  if (has.call(patch, 'folded') && typeof patch.folded !== 'boolean') {
    return fail(-1, 'folded must be boolean');
  }
  const param = has.call(patch, 'param') ? patch.param : undefined;
  if (
    param !== undefined &&
    (!param || typeof param !== 'object' || !isFinite(param.p) ||
      Math.floor(param.p) !== param.p || param.p < 0 || !isFinite(param.value))
  ) {
    return fail(-1, 'invalid device parameter write');
  }
  if (!has.call(patch, 'on') && !has.call(patch, 'folded') && param === undefined) {
    return fail(-1, 'device patch is empty');
  }

  try {
    const devicePath = deviceTargetPath(target);
    if (devicePath === null) return fail(-1, 'device did not resolve');

    // Resolve and check the control before writing anything, so a patch that
    // also carries `on` cannot land half of itself.
    let parameterPath = '';
    if (param !== undefined) {
      parameterPath = devicePath + ' parameters ' + param.p;
      const parameter = at(parameterPath);
      if (!exists(parameter)) return fail(-1, 'device parameter did not resolve');
      // Live's own three-way answer, and only the last of them refuses. A
      // parameter that is changeable but currently inaudible is still the
      // user's to move — see `paramDisabled` on the client side.
      if (gnumOr(parameter, 'state', 0) === 2) {
        return fail(-1, 'device parameter cannot be changed');
      }
      const min = gnum(parameter, 'min');
      const max = gnum(parameter, 'max');
      if (param.value < min || param.value > max) {
        return fail(-1, 'device parameter value is outside its range');
      }
    }

    if (has.call(patch, 'on')) at(devicePath).set('is_active', patch.on ? 1 : 0);
    if (has.call(patch, 'folded')) {
      const view = at(devicePath + ' view');
      if (!exists(view)) return fail(-1, 'device view did not resolve');
      view.set('is_collapsed', patch.folded ? 1 : 0);
    }
    if (param !== undefined) at(parameterPath).set('value', param.value);

    // An unchanged write may not notify, and the shell tier has no deadline to
    // recover from that the way a dragged control does. Nudge the structural
    // re-read for those two and never for a control: at gesture rate this
    // would rebuild every observer in the watch sixteen times a second.
    if (has.call(patch, 'on') || has.call(patch, 'folded')) onChainChange();
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

// --- control bar ------------------------------------------------------
// Tempo, metronome, global clip-launch quantization, Arrangement Record and
// Live's current Scale controls. Seven fixed observers for the whole set,
// reported as one state so a change made in Live and a change made here take
// the same path back to the UI.
//
// The encoded JSON is one Max-safe atom. Scale names contain spaces and Max
// message punctuation is syntax, so sending the raw string would eventually
// turn one valid name into several arguments.

function readTransportState(): BSV.TransportState {
  const set = at('live_set');
  return {
    // Two decimals are all the header renders. Rounding here also keeps tempo
    // automation from publishing changes the user cannot see.
    tempo: Math.round(gnum(set, 'tempo') * 100) / 100,
    metronome: gbool(set, 'metronome'),
    clipTriggerQuantization: gnum(set, 'clip_trigger_quantization'),
    recordMode: gbool(set, 'record_mode'),
    rootNote: gnum(set, 'root_note'),
    scaleName: gstr(set, 'scale_name'),
    scaleMode: gbool(set, 'scale_mode'),
  };
}

function sendTransportState(): void {
  try {
    const state = readTransportState();
    const key = JSON.stringify(state);
    if (key === lastTransportKey) return;
    lastTransportKey = key;
    outlet(0, 'transport_state', encodeMaxAtom(state));
  } catch (e) {
    fail(-1, e);
  }
}

function onTransportChange(): void {
  if (transportDirty) return;
  transportDirty = true;
  // Tempo automation can notify far faster than a two-decimal header needs.
  transportTask.schedule(50);
}

var transportTask = new Task(function () {
  transportDirty = false;
  sendTransportState();
});

function set_transport(encoded: unknown): void {
  if (!deviceReady) return fail(-1, 'device not ready');
  const value = decodeMaxAtom(encoded);
  if (!value || typeof value !== 'object') return fail(-1, 'malformed transport patch');
  const patch = value as BSV.TransportPatch;
  const has = Object.prototype.hasOwnProperty;
  const tempo = has.call(patch, 'tempo') ? Number(patch.tempo) : undefined;
  const quantization = has.call(patch, 'clipTriggerQuantization')
    ? Number(patch.clipTriggerQuantization)
    : undefined;
  const root = has.call(patch, 'rootNote') ? Number(patch.rootNote) : undefined;
  const name = has.call(patch, 'scaleName') ? String(patch.scaleName || '').trim() : undefined;

  // Validate the entire patch before the first set. The Node side already does
  // this, but a malformed direct Max message must not land its early fields and
  // fail halfway through the rest.
  if (tempo !== undefined && (!isFinite(tempo) || tempo < 20 || tempo > 999)) {
    return fail(-1, 'tempo must be 20–999 BPM');
  }
  if (has.call(patch, 'metronome') && typeof patch.metronome !== 'boolean') {
    return fail(-1, 'metronome must be boolean');
  }
  if (
    quantization !== undefined &&
    (!isFinite(quantization) ||
      Math.floor(quantization) !== quantization ||
      quantization < 0 ||
      quantization > 13)
  ) {
    return fail(-1, 'invalid global quantization');
  }
  if (
    root !== undefined &&
    (!isFinite(root) || Math.floor(root) !== root || root < 0 || root > 11)
  ) {
    return fail(-1, 'root note must be 0–11');
  }
  if (name !== undefined && (!name || name.length > 100)) {
    return fail(-1, 'invalid scale name');
  }
  if (has.call(patch, 'scaleMode') && typeof patch.scaleMode !== 'boolean') {
    return fail(-1, 'scale mode must be boolean');
  }
  if (has.call(patch, 'recordMode') && typeof patch.recordMode !== 'boolean') {
    return fail(-1, 'record mode must be boolean');
  }

  try {
    const set = at('live_set');
    if (tempo !== undefined) set.set('tempo', tempo);
    if (has.call(patch, 'metronome')) {
      set.set('metronome', patch.metronome ? 1 : 0);
    }
    if (quantization !== undefined) set.set('clip_trigger_quantization', quantization);
    if (has.call(patch, 'recordMode')) {
      set.set('record_mode', patch.recordMode ? 1 : 0);
    }
    if (root !== undefined) set.set('root_note', root);
    if (name !== undefined) set.set('scale_name', name);
    if (has.call(patch, 'scaleMode')) {
      set.set('scale_mode', patch.scaleMode ? 1 : 0);
    }
    // An unchanged write may not notify. Read back anyway: the state Live
    // accepted, not the attempted patch, is the UI's acknowledgement.
    onTransportChange();
  } catch (e) {
    fail(-1, e);
  }
}

function watch_transport(on: number): void {
  clearTransportObservers();
  if (Number(on) !== 1) return;
  if (!deviceReady) return fail(-1, 'device not ready');
  try {
    const properties = [
      'tempo',
      'metronome',
      'clip_trigger_quantization',
      'record_mode',
      'root_note',
      'scale_name',
      'scale_mode',
    ];
    for (let i = 0; i < properties.length; i++) {
      const observer = new LiveAPI(onTransportChange, 'live_set');
      observer.property = properties[i];
      transportObservers.push(observer);
    }
    sendTransportState();
  } catch (e) {
    clearTransportObservers();
    fail(-1, e);
  }
}

function clearTransportObservers(): void {
  transportTask.cancel();
  transportDirty = false;
  lastTransportKey = '';
  for (let i = 0; i < transportObservers.length; i++) {
    try {
      transportObservers[i].property = '';
    } catch (e) {
      /* object may already be gone */
    }
  }
  transportObservers = [];
}

// --- play state -------------------------------------------------------
// Which slot is playing, which is blinking, and whether the track is armed.
//
// Per-track, not per-clip. Track.playing_slot_index, fired_slot_index and arm
// cover the entire grid in three properties each, so watching the whole set
// costs 3 × trackCount observers. Per-clip observers would be 2 per slot — tens
// of thousands on a real set, which is exactly the chatty design the protocol
// rules exist to prevent.
//
// Arm is here and not only in the mixer's own watcher because it decides what
// every *empty* cell in the grid does: ClipSlot.fire() triggers that slot's
// stop button on an unarmed track and starts recording on an armed one. The
// mixer is observed only while its footer is open; the grid is never closed.
//
// The report goes out as message atoms rather than a Dict, which is the
// opposite of the rule for the snapshot, and deliberately: dict names are
// global, so a push that can fire many times a second would race itself —
// v8 overwriting bsv_playstate before Node had finished reading the previous
// one. The payload is 1 + 3 × trackCount plain numbers with no punctuation in
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
    // `arm` is documented "[not in return/master tracks]", and Song.tracks
    // holds neither — but a track that reports can_be_armed = 0 has no arm to
    // read, so gate on it rather than letting gbool answer 0 for a missing
    // property and a disarmed one alike.
    atoms.push(gbool(a, 'can_be_armed') && gbool(a, 'arm') ? 1 : 0);
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
      // Arming a track changes what every empty cell in its column does, so it
      // reports through the same push. Skipped where Live says the track has
      // no arm at all, which keeps the observer count off group and any other
      // unarmable track rather than attaching to a property that isn't there.
      if (gbool(at('live_set tracks ' + t), 'can_be_armed')) {
        const armObs = new LiveAPI(onPlayChange, 'live_set tracks ' + t);
        armObs.property = 'arm';
        playObservers.push(armObs);
      }
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

// --- track status -----------------------------------------------------
// What each track's stop-row status display shows: how far through a looping
// clip it is, how long a one-shot has left, or how much of a recording exists.
//
// Clip-addressed, which everything else here avoids — and affordable for the
// same reason the rest isn't. A track has at most one playing clip, so this
// costs per *track* despite reading clip properties, where the grid's play
// state would have cost two observers per *slot*.
//
// Polled rather than observed, which is the other departure. `playing_position`
// is observable, but the object holding it changes every time a different clip
// starts, so an observer design means tearing down and rebuilding one observer
// per track on every scene launch — on Live's main thread, at the exact moment
// the set is busiest. A repeating Task costs a fixed, predictable read count
// and nothing at all while the stop row is closed.
//
// The reads are kept down by splitting the clip's facts in two. Only the
// playhead and the recording flag can change without the playing slot changing,
// so those are read every tick and the rest is cached until Live reports a
// different slot in that track.

/** 20 Hz. Fast enough for a smooth pie, half the read rate of the meters. */
var STATUS_INTERVAL_MS = 50;

var statusWatching = false;
/** Which slot each track's cached clip facts were read from; -1 for none. */
var statusSlots: number[] = [];
/** loopStart, loopEnd, looping, inSeconds, sigNum, sigDen — per track, cached. */
var statusFacts: number[][] = [];
/** Last frame sent, so a stopped set doesn't broadcast the same nothing at 20 Hz. */
var lastStatusKey = '';

/**
 * The facts about a playing clip that only a different clip can change.
 *
 * Unwarped audio is the one that matters beyond the loop markers: Live reports
 * its position and markers in seconds where everything else is in beats, and
 * `warping` exists only on audio clips.
 */
function clipFacts(path: string): number[] {
  const clip = at(path);
  const inSeconds =
    gbool(clip, 'is_audio_clip') && !gbool(clip, 'warping') ? 1 : 0;
  return [
    gnumOr(clip, 'loop_start', 0),
    gnumOr(clip, 'loop_end', 0),
    gbool(clip, 'looping') ? 1 : 0,
    inSeconds,
    gnumOr(clip, 'signature_numerator', 4),
    gnumOr(clip, 'signature_denominator', 4),
  ];
}

function clipStatusAtoms(): unknown[] {
  const trackCount = at('live_set').getcount('tracks');
  const atoms: unknown[] = [];
  for (let t = 0; t < trackCount; t++) {
    // -1 is no Session clip and -2 is the stop button; neither is a clip to
    // read. gnumOr rather than gnum so an unreadable property reads as "none"
    // instead of as slot 0.
    const slot = gnumOr(at('live_set tracks ' + t), 'playing_slot_index', -1);
    if (slot < 0) {
      statusSlots[t] = -1;
      continue;
    }
    const path = 'live_set tracks ' + t + ' clip_slots ' + slot + ' clip';
    if (statusSlots[t] !== slot || !statusFacts[t]) {
      // A slot Live calls playing always holds a clip, but it can stop holding
      // one between that read and this one. An empty cursor answers 0 for
      // everything, which `trackStatus` reports as nothing rather than as a
      // zero-length loop, so the frame stays honest without a second check.
      statusFacts[t] = clipFacts(path);
      statusSlots[t] = slot;
    }
    const clip = at(path);
    const facts = statusFacts[t];
    atoms.push(
      t,
      gnumOr(clip, 'playing_position', 0),
      facts[0],
      facts[1],
      facts[2],
      gbool(clip, 'is_recording') ? 1 : 0,
      facts[3],
      facts[4],
      facts[5],
    );
  }
  return atoms;
}

function sendClipStatus(): void {
  if (!statusWatching) return;
  try {
    const atoms = clipStatusAtoms();
    // A set with nothing playing is the resting state, and it would otherwise
    // broadcast an identical empty frame twenty times a second to every client.
    // Positions move constantly while anything sounds, so this only ever
    // suppresses frames that carry no news.
    const key = atoms.join(',');
    if (key === lastStatusKey) return;
    lastStatusKey = key;
    outlet(0, 'clip_status', ...atoms);
  } catch (e) {
    fail(-1, e);
  }
}

var statusTask = new Task(sendClipStatus);
statusTask.interval = STATUS_INTERVAL_MS;

function watch_status(on: number): void {
  clearStatusWatch();
  if (Number(on) !== 1) return;
  if (!deviceReady) return fail(-1, 'device not ready');
  statusWatching = true;
  try {
    sendClipStatus();
    statusTask.repeat();
  } catch (e) {
    clearStatusWatch();
    fail(-1, e);
  }
}

function clearStatusWatch(): void {
  statusWatching = false;
  statusTask.cancel();
  statusSlots = [];
  statusFacts = [];
  lastStatusKey = '';
}

// --- mixer controls ---------------------------------------------------
// The meter panel is also the mixer panel. While it is open, Track.mute,
// Track.solo, Track.arm and MixerDevice volume/panning/sends are observed and
// reported as one coherent state. The observers update a cache from their callback atoms;
// parameter automation therefore costs one small push, not a full LOM walk at
// every automation tick.

function parameterDisplay(parameter: LiveAPI, value: number): string {
  try {
    const displayed = parameter.call('str_for_value', value);
    if (displayed === undefined || displayed === null) return '';
    if (Array.isArray(displayed)) return displayed.map(String).join(' ');
    return String(displayed);
  } catch (e) {
    return '';
  }
}

function readMixerParameter(path: string): BSV.MixerParameterState | null {
  try {
    const parameter = at(path);
    if (!exists(parameter)) return null;
    const min = gnumOr(parameter, 'min', 0);
    const max = gnumOr(parameter, 'max', 1);
    const value = gnumOr(parameter, 'value', min);
    const defaultValue = gnumOr(parameter, 'default_value', value);
    if (
      !isFinite(min) || !isFinite(max) || !isFinite(value) ||
      !isFinite(defaultValue) || min > max
    ) return null;
    const next = Math.max(min, Math.min(max, value));
    return {
      value: next,
      min: min,
      max: max,
      defaultValue: Math.max(min, Math.min(max, defaultValue)),
      display: parameterDisplay(parameter, next),
      enabled: gbool(parameter, 'is_enabled'),
    };
  } catch (e) {
    post('bsv mixer parameter unavailable at ' + path + ': ' + describe(e) + '\n');
    return null;
  }
}

function readMixerTrack(t: number, sendCount: number): BSV.MixerTrackState | null {
  const path = 'live_set tracks ' + t;
  const track = at(path);
  if (!exists(track)) return null;
  const canArm = gbool(track, 'can_be_armed');
  // Read every Track property before readMixerParameter moves the shared cursor.
  const state: BSV.MixerTrackState = {
    t: t,
    active: !gbool(track, 'mute'),
    solo: gbool(track, 'solo'),
    armed: canArm ? gbool(track, 'arm') : false,
    canArm: canArm,
    volume: null,
    pan: null,
    sends: [],
  };
  state.volume = readMixerParameter(path + ' mixer_device volume');
  state.pan = readMixerParameter(path + ' mixer_device panning');
  for (let i = 0; i < sendCount; i++) {
    state.sends.push(readMixerParameter(path + ' mixer_device sends ' + i));
  }
  return state;
}

function readMixerState(): BSV.MixerState {
  const count = at('live_set').getcount('tracks');
  // Sends are additive to the already-working strip. If an embedded runtime
  // rejects this documented child list, preserve volume/pan with zero rows.
  let sendCount = 0;
  if (sendsWatching) {
    try {
      sendCount = at('live_set').getcount('return_tracks');
    } catch (e) {
      post('bsv mixer sends unavailable: ' + describe(e) + '\n');
    }
  }
  const tracks: BSV.MixerTrackState[] = [];
  for (let t = 0; t < count; t++) {
    const state = readMixerTrack(t, sendCount);
    if (state) tracks.push(state);
  }
  return {
    sendCount: sendCount,
    masterVolume: readMixerParameter('live_set master_track mixer_device volume'),
    masterPan: readMixerParameter('live_set master_track mixer_device panning'),
    tracks: tracks,
  };
}

/** Numeric observer callback: `[property, value]` or the bare `[value]` form. */
function mixerValue(args: unknown[], property: string): number | null {
  let raw: unknown;
  if (args.length >= 2 && String(args[0]) === property) raw = args[1];
  else if (args.length === 1) raw = args[0];
  else return null;
  const value = Number(raw);
  return isFinite(value) ? value : null;
}

function queueMixerState(): void {
  if (mixerDirty) return;
  mixerDirty = true;
  // One frame is quick enough for a fader and bounds automated-volume chatter.
  mixerTask.schedule(METER_INTERVAL_MS);
}

function onMixerTrackChange(
  t: number,
  field: 'active' | 'solo' | 'armed' | 'volume' | 'pan',
  property: string,
  args: unknown[],
): void {
  if (!metersWatching || !mixerState) return;
  const value = mixerValue(args, property);
  if (value === null) return;
  const track = mixerState.tracks[t];
  if (!track || track.t !== t) return;
  if (field === 'volume' || field === 'pan') {
    const parameter = track[field];
    if (!parameter) return;
    const next = Math.max(parameter.min, Math.min(parameter.max, value));
    if (parameter.value === next) return;
    parameter.value = next;
    parameter.display = parameterDisplay(
      at('live_set tracks ' + t + ' mixer_device ' + (field === 'volume' ? 'volume' : 'panning')),
      next,
    );
  } else {
    const next = field === 'active' ? value !== 1 : value === 1;
    if (track[field] === next) return;
    track[field] = next;
  }
  queueMixerState();
}

function onMixerSendChange(t: number, index: number, args: unknown[]): void {
  if (!metersWatching || !mixerState) return;
  const value = mixerValue(args, 'value');
  if (value === null) return;
  const track = mixerState.tracks[t];
  if (!track || track.t !== t) return;
  const parameter = track.sends[index];
  if (!parameter) return;
  const next = Math.max(parameter.min, Math.min(parameter.max, value));
  if (parameter.value === next) return;
  parameter.value = next;
  parameter.display = parameterDisplay(
    at('live_set tracks ' + t + ' mixer_device sends ' + index),
    next,
  );
  queueMixerState();
}

function onMasterParameterChange(field: 'masterVolume' | 'masterPan', args: unknown[]): void {
  if (!metersWatching || !mixerState || !mixerState[field]) return;
  const value = mixerValue(args, 'value');
  if (value === null) return;
  const parameter = mixerState[field];
  if (!parameter) return;
  const next = Math.max(parameter.min, Math.min(parameter.max, value));
  if (parameter.value === next) return;
  parameter.value = next;
  parameter.display = parameterDisplay(
    at('live_set master_track mixer_device ' + (field === 'masterVolume' ? 'volume' : 'panning')),
    next,
  );
  queueMixerState();
}

function addMixerTrackObserver(
  t: number,
  field: 'active' | 'solo' | 'armed' | 'volume' | 'pan',
  path: string,
  property: string,
): void {
  const observer = new LiveAPI(
    function (args: unknown[]) { onMixerTrackChange(t, field, property, args); },
    path,
  );
  observer.property = property;
  mixerObservers.push(observer);
}

function addMixerSendObserver(t: number, index: number): void {
  const observer = new LiveAPI(
    function (args: unknown[]) { onMixerSendChange(t, index, args); },
    'live_set tracks ' + t + ' mixer_device sends ' + index,
  );
  observer.property = 'value';
  mixerObservers.push(observer);
}

function sendMixerState(): void {
  if (!metersWatching || !mixerState) return;
  const key = JSON.stringify(mixerState);
  if (key === lastMixerKey) return;
  lastMixerKey = key;
  outlet(0, 'mixer_state', encodeMaxAtom(mixerState));
}

var mixerTask = new Task(function () {
  mixerDirty = false;
  sendMixerState();
});

function clearMixerParameterObservers(): void {
  for (let i = 0; i < mixerObservers.length; i++) {
    try {
      mixerObservers[i].property = '';
    } catch (e) {
      /* object may already be gone */
    }
  }
  mixerObservers = [];
}

function clearMixerStructureObserver(): void {
  if (!mixerStructureObserver) return;
  try {
    mixerStructureObserver.property = '';
  } catch (e) {
    /* object may already be gone */
  }
  mixerStructureObserver = null;
}

var mixerStructureTask = new Task(function () {
  if (!metersWatching || !mixerState) return;
  try {
    const sendCount = at('live_set').getcount('return_tracks');
    if (sendCount === mixerState.sendCount) return;
    const trackCount = at('live_set').getcount('tracks');
    clearMixerParameterObservers();
    startMixerParameterObservers(trackCount);
  } catch (e) {
    fail(-1, 'mixer sends unavailable after return-track change: ' + describe(e));
  }
});

function onMixerStructureChange(args: unknown[]): void {
  if (!metersWatching) return;
  mixerStructureTask.cancel();
  mixerStructureTask.schedule(METER_INTERVAL_MS);
}

function startMixerParameterObservers(trackCount: number): void {
  mixerState = readMixerState();
  for (let t = 0; t < trackCount; t++) {
    const state = mixerState.tracks[t];
    if (!state || state.t !== t) continue;
    const path = 'live_set tracks ' + t;
    addMixerTrackObserver(t, 'active', path, 'mute');
    addMixerTrackObserver(t, 'solo', path, 'solo');
    if (state.canArm) addMixerTrackObserver(t, 'armed', path, 'arm');
    if (state.volume) {
      addMixerTrackObserver(t, 'volume', path + ' mixer_device volume', 'value');
    }
    if (state.pan) {
      addMixerTrackObserver(t, 'pan', path + ' mixer_device panning', 'value');
    }
    for (let i = 0; i < state.sends.length; i++) {
      if (state.sends[i]) addMixerSendObserver(t, i);
    }
  }
  if (mixerState.masterVolume) {
    const master = new LiveAPI(
      function (args: unknown[]) { onMasterParameterChange('masterVolume', args); },
      'live_set master_track mixer_device volume',
    );
    master.property = 'value';
    mixerObservers.push(master);
  }
  if (mixerState.masterPan) {
    const masterPan = new LiveAPI(
      function (args: unknown[]) { onMasterParameterChange('masterPan', args); },
      'live_set master_track mixer_device panning',
    );
    masterPan.property = 'value';
    mixerObservers.push(masterPan);
  }
  sendMixerState();
}

function startMixerStructureObserver(): void {
  if (!sendsWatching || mixerStructureObserver) return;
  try {
    const structure = new LiveAPI(onMixerStructureChange, 'live_set');
    structure.property = 'return_tracks';
    mixerStructureObserver = structure;
  } catch (e) {
    post('bsv return-track observer unavailable: ' + describe(e) + '\n');
  }
}

function startMixerObservers(trackCount: number): void {
  startMixerParameterObservers(trackCount);
  startMixerStructureObserver();
}

function refreshMixerTarget(target: BSV.MixerTarget): void {
  if (!mixerState) return;
  if (target.kind === 'master') {
    mixerState.masterVolume = readMixerParameter('live_set master_track mixer_device volume');
    mixerState.masterPan = readMixerParameter('live_set master_track mixer_device panning');
  } else {
    const state = readMixerTrack(target.t, mixerState.sendCount);
    if (state) mixerState.tracks[target.t] = state;
  }
  queueMixerState();
}

function set_mixer(encoded: unknown): void {
  if (!deviceReady) return fail(-1, 'device not ready');
  const value = decodeMaxAtom(encoded);
  if (!value || typeof value !== 'object') return fail(-1, 'malformed mixer write');
  const source = value as { target?: BSV.MixerTarget; patch?: BSV.MixerPatch };
  const target = source.target;
  const patch = source.patch;
  const has = Object.prototype.hasOwnProperty;
  if (!target || (target.kind !== 'track' && target.kind !== 'master')) {
    return fail(-1, 'invalid mixer target');
  }
  if (!patch || typeof patch !== 'object') return fail(-1, 'mixer patch is missing');
  if (has.call(patch, 'active') && typeof patch.active !== 'boolean') {
    return fail(-1, 'active must be boolean');
  }
  if (has.call(patch, 'solo') && typeof patch.solo !== 'boolean') {
    return fail(-1, 'solo must be boolean');
  }
  if (has.call(patch, 'armed') && typeof patch.armed !== 'boolean') {
    return fail(-1, 'armed must be boolean');
  }
  const volume = has.call(patch, 'volume') ? Number(patch.volume) : undefined;
  const pan = has.call(patch, 'pan') ? Number(patch.pan) : undefined;
  const send = has.call(patch, 'send') ? patch.send : undefined;
  if (volume !== undefined && !isFinite(volume)) return fail(-1, 'volume must be numeric');
  if (pan !== undefined && !isFinite(pan)) return fail(-1, 'pan must be numeric');
  if (
    send !== undefined &&
    (!send || typeof send !== 'object' || !isFinite(send.index) ||
      Math.floor(send.index) !== send.index || send.index < 0 || !isFinite(send.value))
  ) {
    return fail(-1, 'invalid mixer send');
  }
  const hasTrackField =
    has.call(patch, 'active') || has.call(patch, 'solo') || has.call(patch, 'armed');
  if (!hasTrackField && volume === undefined && pan === undefined && send === undefined) {
    return fail(-1, 'mixer patch is empty');
  }
  if (target.kind === 'master' && (hasTrackField || send !== undefined)) {
    return fail(-1, 'Master exposes volume and pan only');
  }

  try {
    const base = target.kind === 'master' ? 'live_set master_track' : 'live_set tracks ' + target.t;
    let track: LiveAPI | null = null;
    if (target.kind === 'track') {
      const count = at('live_set').getcount('tracks');
      if (
        !isFinite(target.t) || Math.floor(target.t) !== target.t ||
        target.t < 0 || target.t >= count
      ) {
        return fail(-1, 'invalid mixer track');
      }
      track = at(base);
      if (!exists(track)) return fail(-1, 'mixer track did not resolve');
      if (has.call(patch, 'armed') && !gbool(track, 'can_be_armed')) {
        return fail(-1, 'track ' + target.t + ' cannot be armed');
      }
    }

    let volumeState: BSV.MixerParameterState | null = null;
    if (volume !== undefined) {
      volumeState = readMixerParameter(base + ' mixer_device volume');
      if (!volumeState) return fail(-1, 'mixer volume did not resolve');
      if (!volumeState.enabled) return fail(-1, 'mixer volume is not enabled');
      if (volume < volumeState.min || volume > volumeState.max) {
        return fail(-1, 'volume is outside the parameter range');
      }
    }
    let panState: BSV.MixerParameterState | null = null;
    if (pan !== undefined) {
      panState = readMixerParameter(base + ' mixer_device panning');
      if (!panState) return fail(-1, 'mixer pan did not resolve');
      if (!panState.enabled) return fail(-1, 'mixer pan is not enabled');
      if (pan < panState.min || pan > panState.max) {
        return fail(-1, 'pan is outside the parameter range');
      }
    }
    let sendState: BSV.MixerParameterState | null = null;
    if (send !== undefined) {
      const sendCount = at('live_set').getcount('return_tracks');
      if (send.index >= sendCount) return fail(-1, 'invalid send index');
      sendState = readMixerParameter(base + ' mixer_device sends ' + send.index);
      if (!sendState) return fail(-1, 'mixer send did not resolve');
      if (!sendState.enabled) return fail(-1, 'mixer send is not enabled');
      if (send.value < sendState.min || send.value > sendState.max) {
        return fail(-1, 'send is outside the parameter range');
      }
    }

    // Every field is valid before the first write, so a malformed patch cannot
    // land its early fields and fail halfway through the strip.
    if (target.kind === 'track') {
      if (has.call(patch, 'active')) at(base).set('mute', patch.active ? 0 : 1);
      if (has.call(patch, 'solo')) at(base).set('solo', patch.solo ? 1 : 0);
      if (has.call(patch, 'armed')) at(base).set('arm', patch.armed ? 1 : 0);
    }
    if (volume !== undefined) at(base + ' mixer_device volume').set('value', volume);
    if (pan !== undefined) at(base + ' mixer_device panning').set('value', pan);
    if (send !== undefined) {
      at(base + ' mixer_device sends ' + send.index).set('value', send.value);
    }
    // An unchanged write may not notify. Read back the one target regardless.
    refreshMixerTarget(target);
  } catch (e) {
    fail(-1, e);
  }
}

function clearMixerObservers(): void {
  mixerTask.cancel();
  mixerStructureTask.cancel();
  mixerDirty = false;
  lastMixerKey = '';
  mixerState = null;
  clearMixerParameterObservers();
  clearMixerStructureObserver();
}

// --- output meters ----------------------------------------------------
// Audio-output tracks use Live's momentary left/right peaks, combined to the
// louder channel. `output_meter_level` has a one-second hold and visibly lags a
// real meter; it remains only as the fallback for MIDI-only tracks, for which
// Live exposes no momentary property. The stereo properties cost more Live GUI
// work, which is why these observers exist only while the meter UI is open.

/** Roughly one frame at 30 Hz. Every frame carries all tracks plus Master. */
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

function queueMeterLevel(t: number | null, level: number): void {
  const next = Math.max(0, Math.min(1, level));
  if (t === null) {
    masterMeterLevel = next;
    return;
  }
  if (meterLevels[t] === next) return;
  meterLevels[t] = next;
}

function onMeterChange(
  t: number | null,
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
  if (t === null) {
    if (channel === 'left') masterMeterLeft = level;
    else masterMeterRight = level;
    queueMeterLevel(null, Math.max(masterMeterLeft, masterMeterRight));
    return;
  }
  if (channel === 'left') meterLeft[t] = level;
  else meterRight[t] = level;
  queueMeterLevel(t, Math.max(meterLeft[t] ?? 0, meterRight[t] ?? 0));
}

function addMeterObserver(
  t: number | null,
  path: string,
  property: 'output_meter_left' | 'output_meter_right' | 'output_meter_level',
  channel: 'left' | 'right' | 'mono',
): void {
  const observer = new LiveAPI(
    function (args: unknown[]) { onMeterChange(t, channel, property, args); },
    path,
  );
  observer.property = property;
  meterObservers.push(observer);
}

function sendMeterLevels(): void {
  if (!metersWatching) return;
  const atoms: unknown[] = [masterMeterLevel];
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
        addMeterObserver(t, 'live_set tracks ' + t, 'output_meter_left', 'left');
        addMeterObserver(t, 'live_set tracks ' + t, 'output_meter_right', 'right');
      } else {
        addMeterObserver(t, 'live_set tracks ' + t, 'output_meter_level', 'mono');
      }
    }
    // Master is a Track, but it lives at Song.master_track rather than in
    // Song.tracks. Keep it in this same watcher and frame so the toggle owns
    // one complete mixer view. Isolate this addition from the already-working
    // track path: if the actual Max runtime rejects a documented master atom
    // shape, report it and leave this meter silent without losing every track.
    queueMeterLevel(null, 0);
    const masterObserverStart = meterObservers.length;
    try {
      const master = at('live_set master_track');
      if (gbool(master, 'has_audio_output')) {
        addMeterObserver(null, 'live_set master_track', 'output_meter_left', 'left');
        addMeterObserver(null, 'live_set master_track', 'output_meter_right', 'right');
      } else {
        addMeterObserver(null, 'live_set master_track', 'output_meter_level', 'mono');
      }
    } catch (e) {
      for (let i = masterObserverStart; i < meterObservers.length; i++) {
        try {
          meterObservers[i].property = '';
        } catch {
          /* object may already be gone */
        }
      }
      meterObservers.length = masterObserverStart;
      fail(-1, 'master meter unavailable: ' + describe(e));
    }
    // Controls are a sibling stream to levels, but share the panel's lifetime.
    // Isolate them so one undocumented runtime atom shape cannot cost the
    // already-working output meters.
    try {
      startMixerObservers(trackCount);
    } catch (e) {
      clearMixerObservers();
      fail(-1, 'mixer controls unavailable: ' + describe(e));
    }
    sendMeterLevels();
    meterTask.repeat();
  } catch (e) {
    clearMeterObservers();
    fail(-1, e);
  }
}

function watch_sends(on: number): void {
  sendsWatching = Number(on) === 1;
  mixerStructureTask.cancel();
  clearMixerStructureObserver();
  if (sendsWatching && !deviceReady) {
    sendsWatching = false;
    return fail(-1, 'device not ready');
  }
  if (!metersWatching) return;
  try {
    clearMixerParameterObservers();
    lastMixerKey = '';
    const trackCount = at('live_set').getcount('tracks');
    startMixerParameterObservers(trackCount);
    startMixerStructureObserver();
  } catch (e) {
    // A failed optional send path must not take away the mixer that was already
    // working. Fall back to the base strip and make the failure visible.
    sendsWatching = false;
    clearMixerParameterObservers();
    try {
      startMixerParameterObservers(at('live_set').getcount('tracks'));
    } catch (fallbackError) {
      clearMixerObservers();
      fail(-1, 'mixer controls unavailable: ' + describe(fallbackError));
    }
    fail(-1, 'mixer sends unavailable: ' + describe(e));
  }
}

function clearMeterObservers(): void {
  // Set this before detaching properties: a late callback from an observer
  // being torn down must not schedule one last batch after watching is off.
  metersWatching = false;
  meterTask.cancel();
  clearMixerObservers();
  meterLevels = [];
  meterLeft = [];
  meterRight = [];
  masterMeterLevel = 0;
  masterMeterLeft = 0;
  masterMeterRight = 0;
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
// **Edits that move nothing** used to be the hole here — deleting, renaming or
// recoloring a clip in place leaves the cursor where it is, so nothing fired.
// But the cursor is already ON the thing being edited, because you have to
// select something in Live to edit it. So watch that one object's properties
// too: `has_clip` on the slot under the cursor, and the contained clip's `name`
// and `color_index`. Three more observers, and they move with the cursor, so the
// count is the same on a 4-track set and an 848-scene one.
//
// **They are attached from the Task, never from a callback.** Constructing a
// LiveAPI can call back synchronously before the observed property reports (see
// the note on `meterValue`), so attaching inside a notification risks re-entering
// the handler you are standing in — and the clip may not resolve in the same tick
// `has_clip` reports 1 anyway. The rebuild is unconditional rather than gated on
// "did the cursor move", precisely because the clip under a stationary cursor can
// come and go.
//
// What remains uncovered is what no observer can reach: `Clip.length` and
// `Track.fold_state` have no `observe` at all, and another M4L device or a remote
// script announces nothing. The client's staleness backstop is for those.

/** How long to let the cursor settle before re-reading. */
const SEL_DEBOUNCE_MS = 100;

var selObservers: LiveAPI[] = [];
/**
 * Observers on the object under the cursor — the slot, and its clip if there is
 * one. Rebuilt on every flush, torn down with the cursor observers.
 */
var cursorObservers: LiveAPI[] = [];
/** Where `cursorObservers` are currently pointed, so a rebuild can skip a no-op. */
var cursorAt = '';
/** Last cursor seen, as raw ids — comparing these needs no index resolution. */
var selTrackId = 0;
var selSceneId = 0;
/** Track index the cursor was in before its current position — a move's source. */
var selPrevTrack = -1;
/** Track indexes whose clips await a re-read, used as a set. */
var selDirty: { [t: string]: boolean } = {};
/** Scene and track *rows* awaiting a re-read — names, colors, tempo. */
var sceneDirty: { [s: string]: boolean } = {};
var trackRowDirty: { [t: string]: boolean } = {};
/** Master is outside Song.tracks, so its color has its own dirty bit. */
var masterColorDirty = false;
/** LOM id -> track index. Rebuilt whenever the set's structure changes. */
var trackIndexById: { [id: string]: number } | null = null;
/** LOM id -> scene index, on the same terms. Only the cursor observers need it. */
var sceneIndexById: { [id: string]: number } | null = null;
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
 * One scene row, exactly as a snapshot describes it.
 *
 * Shared by the walk and by a scoped re-read so there is **one** definition of
 * what a scene row is. Two would drift, and the symptom would be a grid that
 * disagrees with itself depending on which path last wrote a row.
 *
 * Null when the scene doesn't resolve — deleted under us, which the structure
 * observer is already telling everyone about.
 */
function readSceneRow(s: number): BSV.Scene | null {
  const a = at('live_set scenes ' + s);
  if (!exists(a)) return null;
  return {
    i: s,
    name: gstr(a, 'name'),
    color: gnum(a, 'color'),
    // -1 when the scene has no color; slot 0 is a real color.
    colorIndex: gnumOr(a, 'color_index', -1),
    isEmpty: gbool(a, 'is_empty'),
    tempo: gnum(a, 'tempo'),
  };
}

/**
 * One track row, on the same terms.
 *
 * `groupIndex` resolves through `trackIndexOf` rather than the walk's own
 * two-pass map. That's sound here for the reason the two-pass map exists at all:
 * it only matters that every id be resolvable, and grouping cannot change
 * without adding or removing a track — which is structural, drops the cache, and
 * sends every client for a full walk anyway.
 */
function readTrackRow(t: number): BSV.Track | null {
  const a = at('live_set tracks ' + t);
  if (!exists(a)) return null;
  const isGroup = gbool(a, 'is_foldable');
  const isGrouped = gbool(a, 'is_grouped');
  return {
    i: t,
    name: gstr(a, 'name'),
    color: gnum(a, 'color'),
    colorIndex: gnum(a, 'color_index'),
    isMidi: gbool(a, 'has_midi_input'),
    isGroup: isGroup,
    isGrouped: isGrouped,
    groupIndex: isGrouped ? trackIndexOf(gid(a, 'group_track')) : -1,
    // fold_state is documented as only available when is_foldable, so don't ask
    // for it on a track that isn't a group.
    isFolded: isGroup ? gbool(a, 'fold_state') : false,
  };
}

/**
 * Live's Master color, isolated from the ordinary-track path.
 *
 * Master is documented as a Track at `Song.master_track`, with the same `color`
 * property as ordinary tracks, but it is not part of `Song.tracks`. Returning
 * null keeps a missing or runtime-rejected atom visible and harmless: the UI
 * retains its neutral header instead of the entire snapshot failing.
 */
function readMasterColor(): number | null {
  try {
    const master = at('live_set master_track');
    if (!exists(master)) return null;
    const color = gnumOr(master, 'color', -1);
    return color >= 0 ? color : null;
  } catch (e) {
    post('bsv master color unavailable: ' + describe(e) + '\n');
    return null;
  }
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

/**
 * The clip under the cursor changed without the cursor moving — a rename, a
 * recolor, a delete, or a clip appearing where there wasn't one.
 *
 * Marks the cursor's own track and goes through the same debounce and re-read as
 * a selection change. It deliberately learns nothing from *which* property fired:
 * the re-read says what the track holds now, which is the same answer whichever
 * of the three it was, and inference is the thing this design keeps out.
 */
function onCursorEdit(): void {
  if (!cursorObservers.length) return;
  try {
    const t = trackIndexOf(selTrackId);
    if (t < 0) return;
    selDirty[String(t)] = true;
    selTask.cancel();
    selTask.schedule(SEL_DEBOUNCE_MS);
  } catch (e) {
    fail(-1, e);
  }
}

/**
 * The scene under the cursor was renamed, recolored or retempoed.
 *
 * **The one that matters most in this project**, because a scene name is not a
 * label on the mapping — it *is* the mapping, and everything downstream is
 * re-derived from it. A rename in Live used to be invisible until something
 * spent a full walk finding out.
 */
function onCursorSceneEdit(): void {
  if (!cursorObservers.length) return;
  try {
    const s = sceneIndexOf(selSceneId);
    if (s < 0) return;
    sceneDirty[String(s)] = true;
    selTask.cancel();
    selTask.schedule(SEL_DEBOUNCE_MS);
  } catch (e) {
    fail(-1, e);
  }
}

/** The track under the cursor was renamed or recolored. */
function onCursorTrackEdit(): void {
  if (!cursorObservers.length) return;
  try {
    const t = trackIndexOf(selTrackId);
    if (t < 0) return;
    trackRowDirty[String(t)] = true;
    selTask.cancel();
    selTask.schedule(SEL_DEBOUNCE_MS);
  } catch (e) {
    fail(-1, e);
  }
}

/** Master was recolored in Live. It has no ordinary-track index to dirty. */
function onMasterColorEdit(): void {
  if (!selObservers.length) return;
  masterColorDirty = true;
  selTask.cancel();
  selTask.schedule(SEL_DEBOUNCE_MS);
}

/** Attach one observer, or say why not. Never throws into a rebuild. */
function observeAt(path: string, property: string, cb: () => void): LiveAPI | null {
  const a = new LiveAPI(cb, path);
  if (!exists(a)) return null;
  a.property = property;
  return a;
}

/**
 * Point the cursor observers at wherever the cursor is now.
 *
 * **Only ever called from `selTask`.** Attaching inside a notification callback
 * risks re-entering it — constructing a LiveAPI can fire its callback
 * synchronously, which `meterValue` records — and a clip that has just appeared
 * may not resolve in the tick `has_clip` reported it.
 *
 * A slot with no clip gets one observer, not three: there is no Clip object to
 * attach to. `has_clip` is what brings the other two back when one arrives.
 */
function rebuildCursorObservers(): void {
  const t = trackIndexOf(selTrackId);
  const s = sceneIndexOf(selSceneId);
  const where = t + ':' + s;
  // The common case by far — a flush caused by an edit, not by the cursor moving.
  if (where === cursorAt && cursorObservers.length) return;
  clearCursorObservers();
  if (t < 0 || s < 0) return;
  try {
    const next: LiveAPI[] = [];
    const add = (a: LiveAPI | null) => {
      if (a) next.push(a);
    };
    const slotPath = 'live_set tracks ' + t + ' clip_slots ' + s;

    // A group track has no clip slots of its own, so this resolves to nothing —
    // check before probing rather than letting `get` post an error per rebuild.
    const slot = at(slotPath);
    if (exists(slot)) {
      add(observeAt(slotPath, 'has_clip', onCursorEdit));
      if (gbool(slot, 'has_clip')) {
        add(observeAt(slotPath + ' clip', 'name', onCursorEdit));
        add(observeAt(slotPath + ' clip', 'color_index', onCursorEdit));
      }
    }

    // **`color`, not `color_index`.** Live's own docstring says a scene's
    // color_index "can be None for no color", and LOM.md records that the page
    // calls it writable when it is not — so it is the member this project has
    // already been wrong about once. `color` is always an int and moves with it,
    // so a recolor fires either way and this asks nothing of a nullable.
    //
    // No `tempo_enabled` observer: disabling a scene tempo makes `tempo` read
    // -1 and enabling it makes it read a value, so the `tempo` observer already
    // fires for both. A second one would cost an observer to learn nothing.
    add(observeAt('live_set scenes ' + s, 'name', onCursorSceneEdit));
    add(observeAt('live_set scenes ' + s, 'color', onCursorSceneEdit));
    add(observeAt('live_set scenes ' + s, 'tempo', onCursorSceneEdit));

    add(observeAt('live_set tracks ' + t, 'name', onCursorTrackEdit));
    add(observeAt('live_set tracks ' + t, 'color', onCursorTrackEdit));

    cursorObservers = next;
    cursorAt = where;
  } catch (e) {
    // Never fatal to the flush: the delta this was called alongside is still
    // worth publishing, and losing the cursor observers only costs coverage
    // until the next flush rebuilds them.
    post('bsv cursor observers: ' + describe(e) + '\n');
  }
}

function clearCursorObservers(): void {
  for (let i = 0; i < cursorObservers.length; i++) {
    try {
      cursorObservers[i].property = '';
    } catch (e) {
      /* object may already be gone */
    }
  }
  cursorObservers = [];
  cursorAt = '';
}

/**
 * The cursor's scene as an index, through a cache of its own.
 *
 * The scene axis never needed resolving before — a re-read scoped to whole
 * tracks doesn't care which scene the cursor is in. The slot observer does, and
 * it needs it on **every cursor move**, so this cannot be a walk: a set is far
 * more likely to have hundreds of scenes than hundreds of tracks, and the track
 * walk alone already measured 11ms. Same cache discipline as `trackIndexById`,
 * dropped by the same structural change, for the same reason.
 */
function sceneIndexOf(id: number): number {
  if (!id) return -1;
  if (!sceneIndexById) {
    const map: { [id: string]: number } = {};
    const count = at('live_set').getcount('scenes');
    for (let s = 0; s < count; s++) map[String(at('live_set scenes ' + s).id)] = s;
    sceneIndexById = map;
  }
  const found = sceneIndexById[String(id)];
  return found === undefined ? -1 : found;
}

/**
 * What we last told clients each track holds.
 *
 * A re-read that finds nothing new must publish **nothing** — not an empty
 * delta, and above all not a `nextRev()`. `rev` is a single global shared by
 * every client, so a bump nobody needed is a chance for some *other* client's
 * next delta to fail `canApplyDelta` and answer with a full ~950ms walk. Before
 * this, every click the user made in Live bumped it: a click re-reads a track,
 * finds it identical, and published that non-event anyway.
 *
 * Keyed by track index, so a structural change drops it with the rest.
 */
var digests: { [k: string]: string } = {};

/** Everything about a clip a delta can carry and a client can see change. */
function clipDigest(c: BSV.Clip): string {
  return c.s + '|' + c.name + '|' + c.colorIndex + '|' + c.length;
}

/** The same for a scene row, and for a track row. */
function sceneDigest(s: BSV.Scene): string {
  return s.name + '|' + s.colorIndex + '|' + s.color + '|' + s.tempo + '|' + s.isEmpty;
}

function trackRowDigest(t: BSV.Track): string {
  return t.name + '|' + t.colorIndex + '|' + t.color + '|' + t.isFolded;
}

/** Seeded from a full walk, which has already read all four sources. One pass each. */
function seedDigests(
  trackCount: number,
  clips: BSV.Clip[],
  scenes: BSV.Scene[],
  tracks: BSV.Track[],
  masterColor: number | null,
): void {
  const acc: { [t: string]: string[] } = {};
  for (let t = 0; t < trackCount; t++) acc[String(t)] = [];
  for (let i = 0; i < clips.length; i++) {
    const k = String(clips[i].t);
    if (!acc[k]) acc[k] = [];
    acc[k].push(clipDigest(clips[i]));
  }
  digests = {};
  for (const k in acc) {
    if (Object.prototype.hasOwnProperty.call(acc, k)) digests['c' + k] = acc[k].join(';');
  }
  for (let i = 0; i < scenes.length; i++) digests['s' + scenes[i].i] = sceneDigest(scenes[i]);
  for (let i = 0; i < tracks.length; i++) digests['t' + tracks[i].i] = trackRowDigest(tracks[i]);
  digests.m = String(masterColor);
}

/** The dirty sets, as sorted indexes. */
function indexesOf(set: { [k: string]: boolean }): number[] {
  const out: number[] = [];
  for (const k in set) {
    if (Object.prototype.hasOwnProperty.call(set, k)) out.push(Number(k));
  }
  out.sort(function (a, b) {
    return a - b;
  });
  return out;
}

/**
 * One track's digest out of a re-read.
 *
 * `readTrackClips` appends in scene order and `flushSelection` walks tracks in
 * ascending order, so a track's clips are contiguous and sorted — but this
 * filters rather than assuming that, because the assumption is invisible if it
 * ever stops holding and the cost is a scan of a list that is already in hand.
 */
function digestOfTrack(t: number, clips: BSV.Clip[]): string {
  const parts: string[] = [];
  for (let i = 0; i < clips.length; i++) {
    if (clips[i].t === t) parts.push(clipDigest(clips[i]));
  }
  return parts.join(';');
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
    //
    // `clipJob` belongs here as much as the other two and was missing: a clip
    // drag is reconciled client-side by `applyClipMove` from the plan it sent,
    // and a delta landing mid-drag races exactly that.
    //
    // `snapJob` belongs here too, and for a reason of its own: a delta bumps
    // `rev`, and a walk that publishes afterwards with its own `nextRev()`
    // would leave every client holding a delta computed against a snapshot they
    // never saw.
    if (job || moveJob || clipJob || snapJob) {
      selTask.schedule(SEL_DEBOUNCE_MS);
      return;
    }

    // Wherever the cursor ended up is where the next in-place edit will happen.
    // Done here rather than in the callback, and before the early return below,
    // so a flush that publishes nothing still leaves the observers pointed right.
    rebuildCursorObservers();

    const tracks = indexesOf(selDirty);
    const dirtyScenes = indexesOf(sceneDirty);
    const dirtyRows = indexesOf(trackRowDirty);
    const dirtyMasterColor = masterColorDirty;
    selDirty = {};
    sceneDirty = {};
    trackRowDirty = {};
    masterColorDirty = false;
    if (!tracks.length && !dirtyScenes.length && !dirtyRows.length && !dirtyMasterColor) {
      return;
    }

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

    // Rows. A row that no longer resolves is dropped rather than reported, on
    // the same grounds as a vanished track: the structure observer has already
    // sent everyone for a walk, and describing a scene that isn't there would
    // outlive that walk in some client's copy.
    const sceneRows: BSV.Scene[] = [];
    for (let i = 0; i < dirtyScenes.length; i++) {
      const row = readSceneRow(dirtyScenes[i]);
      if (row) sceneRows.push(row);
    }
    const trackRows: BSV.Track[] = [];
    for (let i = 0; i < dirtyRows.length; i++) {
      const row = readTrackRow(dirtyRows[i]);
      if (row) trackRows.push(row);
    }
    const masterColor = dirtyMasterColor ? readMasterColor() : undefined;

    // Nothing any client could see is different, so say nothing. Publishing an
    // identical delta would be harmless on its own; bumping `rev` for it is not,
    // because that sequence is shared and a client whose next delta doesn't line
    // up answers with a full walk.
    let moved = false;
    const fresh: { [k: string]: string } = {};
    for (let i = 0; i < scanned.length; i++) {
      const t = scanned[i];
      const d = digestOfTrack(t, clips);
      fresh['c' + t] = d;
      // An unknown track counts as changed: never having described it is not the
      // same as having described it as this.
      if (digests['c' + t] !== d) moved = true;
    }
    for (let i = 0; i < sceneRows.length; i++) {
      const d = sceneDigest(sceneRows[i]);
      fresh['s' + sceneRows[i].i] = d;
      if (digests['s' + sceneRows[i].i] !== d) moved = true;
    }
    for (let i = 0; i < trackRows.length; i++) {
      const d = trackRowDigest(trackRows[i]);
      fresh['t' + trackRows[i].i] = d;
      if (digests['t' + trackRows[i].i] !== d) moved = true;
    }
    if (dirtyMasterColor) {
      const d = String(masterColor);
      fresh.m = d;
      if (digests.m !== d) moved = true;
    }
    if (!moved) return;
    for (const k in fresh) {
      if (Object.prototype.hasOwnProperty.call(fresh, k)) digests[k] = fresh[k];
    }

    const prevRev = rev;
    const payload: BSV.SnapshotDelta = {
      rev: nextRev(),
      prevRev: prevRev,
      clipScope: scanned,
      clips: clips,
      ms: Date.now() - t0,
    };
    // Absent rather than empty, so a delta that is only about clips stays
    // exactly the message it has always been.
    if (sceneRows.length) payload.sceneRows = sceneRows;
    if (trackRows.length) payload.trackRows = trackRows;
    if (masterColor !== undefined) payload.masterColor = masterColor;
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

    // Master is outside Song.tracks, so the cursor's ordinary-track observer
    // cannot ever cover it. Keep this addition isolated: if the documented
    // master path or atom shape fails in the embedded runtime, cursor following
    // for every ordinary track still works.
    try {
      const master = new LiveAPI(onMasterColorEdit, 'live_set master_track');
      if (exists(master)) {
        master.property = 'color';
        selObservers.push(master);
      }
    } catch (e) {
      post('bsv master color observer unavailable: ' + describe(e) + '\n');
    }

    // Seed from where the cursor is now rather than waiting to be told. An
    // observer on an object-valued property was not seen to fire on attach the
    // way the numeric ones do, and without a starting position the first move
    // would have no previous track — so its source would go unread, which is
    // the one failure this whole design is built to avoid.
    const view = at('live_set view');
    selTrackId = gid(view, 'selected_track');
    selSceneId = gid(view, 'selected_scene');
    selPrevTrack = trackIndexOf(selTrackId);
    // Cover wherever the cursor already is, rather than waiting for it to move.
    // A rename of the clip that happened to be selected when the browser
    // connected is exactly the edit this is here to catch. Safe to attach
    // directly: this is a message handler, not an observer callback.
    rebuildCursorObservers();
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
  clearCursorObservers();
  selDirty = {};
  sceneDirty = {};
  trackRowDirty = {};
  masterColorDirty = false;
  selPrevTrack = -1;
  selTrackId = 0;
  selSceneId = 0;
}

// --- observers --------------------------------------------------------
// Structure only: the track and scene lists. Content is followed by watching
// the selection instead — see *following Live* above.

function onStructureChange(): void {
  // Every index now means something different, so anything addressed by one is
  // stale: both id caches, the dirty set, and the cursor's previous position.
  // Clients re-walk on `changed`, which is the only honest answer to a set that
  // just renumbered itself.
  trackIndexById = null;
  sceneIndexById = null;
  // Keyed by track index, so every entry now describes a different track. A
  // surviving digest would make a genuinely-changed track look unchanged and
  // suppress the delta for it.
  digests = {};
  selDirty = {};
  sceneDirty = {};
  trackRowDirty = {};
  masterColorDirty = false;
  selPrevTrack = -1;
  selTask.cancel();
  // A walk in progress is now reading a set that has renumbered itself under
  // it. Every index it has already collected means something else, so the half
  // it has is not the half it is about to read. `snapshotStep` starts over.
  if (snapJob) snapJob.stale = true;
  // Path-addressed like the cursor's, and re-pointed by the same renumbering.
  // Rebuilding is the Task's job — schedule it rather than touching the LOM
  // from inside this callback.
  if (chainWatching) onChainChange();
  // The cursor observers are path-addressed, and a path silently re-points when
  // a scene is inserted above it — `live_set tracks 3 clip_slots 40` is a
  // different slot than it was a moment ago. An observer left attached would go
  // on reporting, about the wrong slot, and nothing would ever say so. Drop
  // them; the next flush rebuilds against the indexes that now apply.
  clearCursorObservers();
  // add_scenes creates a fixed run synchronously. Its Node-side completion
  // broadcasts one structural change after all eight rows are configured;
  // emitting once per create would launch eight overlapping full snapshots.
  if (structuralJob) return;
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
// **Answers go to the Max window, not over the wire.** These questions concern
// behavior visible only with Live open, so the readout has to be somewhere you
// can watch without leaving Live.
//
// Observer-driven probes only read. Live's binary carries the error string
// "Changes cannot be triggered by notifications", so a write from inside an
// observer callback throws — `diagWatch` deliberately never writes. The view
// probes write only from an explicit CLI-triggered message.

/** Selection observers from `diag watch`. */
var diagObservers: LiveAPI[] = [];
/** Slot observers from `diag attach`, kept apart so a watch survives one. */
var diagAttached: LiveAPI[] = [];
/** Last cursor position reported, so the watch log shows moves not repeats. */
var diagLastSel = '';
/** Remaining calls in the scheduled `diag scroll` probe. */
var diagScrollRemaining = 0;
/** Application.View direction: 0 = up, 1 = down. */
var diagScrollDirection = 0;
/** Original signed count, retained for the completion log. */
var diagScrollSigned = 0;
/** Exact selection requested by `diag selectscene`, for deferred readback. */
var diagSelectedSceneId = 0;
var diagSelectedSceneIndex = -1;

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

/**
 * Does one `Application.View.scroll_view` call move Session by one scene row?
 *
 * A synchronous loop of calls produced one UI move in Live, so this probe
 * schedules one call per Task tick to test whether deferral was the reason.
 * Positive steps are down; negative steps are up. Put Live in Session View and
 * watch it while running this probe.
 */
function diagScroll(steps: number): void {
  const signed = Math.trunc(Number(steps) || 0);
  if (!signed) throw new Error('scroll needs non-zero signed steps');
  if (Math.abs(signed) > DIAG_SCROLL_MAX) {
    throw new Error('scroll is limited to ' + DIAG_SCROLL_MAX + ' steps per probe');
  }

  const view = at('live_app view');
  if (!exists(view)) throw new Error('live_app view did not resolve');

  diagScrollTask.cancel();
  diagScrollSigned = signed;
  diagScrollRemaining = Math.abs(signed);
  diagScrollDirection = signed > 0 ? 1 : 0;
  diagScrollTask.repeat();
  post(
    'bsv diag scroll: queued ' + Math.abs(signed) + ' Session ' +
      (signed > 0 ? 'down' : 'up') + ' call(s), ' + DIAG_SCROLL_INTERVAL_MS +
      'ms apart\n',
  );
}

function diagScrollStep(): void {
  if (diagScrollRemaining <= 0) {
    diagScrollTask.cancel();
    return;
  }
  try {
    // The named view keeps the test specific to Session rather than whichever
    // document view currently has focus.
    at('live_app view').call('scroll_view', diagScrollDirection, 'Session', 0);
    diagScrollRemaining--;
    if (diagScrollRemaining === 0) {
      diagScrollTask.cancel();
      post(
        'bsv diag scroll: completed ' + Math.abs(diagScrollSigned) + ' Session ' +
          (diagScrollSigned > 0 ? 'down' : 'up') + ' call(s)\n',
      );
    }
  } catch (e) {
    diagScrollTask.cancel();
    diagScrollRemaining = 0;
    post('bsv diag scroll: ' + describe(e) + '\n');
  }
}

var diagScrollTask = new Task(diagScrollStep);
diagScrollTask.interval = DIAG_SCROLL_INTERVAL_MS;

/**
 * Can `Song.View.selected_scene` address and reveal a scene in one operation?
 *
 * The property takes a Scene object, so the CLI's zero-based index is resolved
 * to its runtime id before setting it. The readback proves selection only; the
 * visual reveal still has to be watched in Live.
 */
function diagSelectScene(index: number): void {
  const sceneIndex = Number(index);
  diagScrollTask.cancel();
  diagScrollRemaining = 0;
  const sceneId = setSelectedScene(sceneIndex);
  diagSelectedSceneId = sceneId;
  diagSelectedSceneIndex = sceneIndex;
  diagSelectSceneTask.cancel();
  diagSelectSceneTask.schedule(DIAG_SCROLL_INTERVAL_MS);
  post(
    'bsv diag selectscene: requested scene ' + sceneIndex + ' id ' + sceneId + '\n',
  );
}

var diagSelectSceneTask = new Task(function () {
  try {
    const selectedId = gid(at('live_set view'), 'selected_scene');
    post(
      'bsv diag selectscene: scene ' + diagSelectedSceneIndex + ' requested id ' +
        diagSelectedSceneId + ', read back id ' + selectedId +
        (selectedId === diagSelectedSceneId ? ' — SELECTED' : ' — DID NOT SELECT') + '\n',
    );
  } catch (e) {
    post('bsv diag selectscene readback: ' + describe(e) + '\n');
  }
});

/**
 * What Live — and therefore Push — believes this device's parameters are.
 *
 * Push draws an encoder's value text from `DeviceParameter.value_items`, so
 * that list is the only thing worth measuring when a label doesn't appear: it
 * is the last place the name exists before it becomes pixels on hardware. Max's
 * own state doesn't settle it, because the question is precisely whether Live
 * re-read Max after the device loaded.
 *
 * Read it once before writing anything, and again after `diag labels`. The two
 * readings together say which half is at fault:
 *
 *   - `min`/`max` move and `value_items` doesn't → Max took the new item list
 *     and Live's copy is frozen at load. The labels can never arrive this way.
 *   - neither moves → Max rejected the message; the atoms or the count are
 *     wrong and the shape is worth varying.
 *   - both move → Live has the names and anything still missing is Push's own
 *     caching, which is a different search.
 */
function diagParam(): void {
  const dev = at('this_device');
  if (!exists(dev)) {
    post('bsv diag param: this_device did not resolve\n');
    return;
  }
  const count = dev.getcount('parameters');
  post('bsv diag param: ' + count + ' parameter(s) on this device\n');
  // Canonical paths, not `id N` — [`LOM.md`](../LOM.md) records `goto('id N')`
  // as not resolving here, and a probe that silently addresses nothing would
  // read as "Live has no labels" no matter what Live actually holds.
  for (let i = 0; i < count; i++) {
    const p = at('this_device parameters ' + i);
    if (!exists(p)) {
      post('bsv diag param: [' + i + '] did not resolve\n');
      continue;
    }
    const items = p.get('value_items');
    // Reported as a count *and* as text: a name carrying a space arrives as
    // several atoms, so a list that reads right when joined can still be the
    // wrong length, and the length is what Push indexes into.
    const list = Array.isArray(items) ? items : items === undefined ? [] : [items];
    post(
      'bsv diag param: [' + i + '] "' + gstr(p, 'name') + '"' +
        ' quantized=' + (gbool(p, 'is_quantized') ? 1 : 0) +
        ' min=' + gnum(p, 'min') + ' max=' + gnum(p, 'max') +
        ' value=' + gnum(p, 'value') +
        ' items=' + list.length + '\n',
    );
    if (list.length) post('bsv diag param:      ' + list.map(String).join(' | ') + '\n');
  }
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
    else if (w === 'scroll') diagScroll(arg);
    else if (w === 'selectscene') diagSelectScene(arg);
    else if (w === 'param') diagParam();
    else {
      post(
        'bsv diag: unknown "' + w + '". Try: ids | slot | sel | watch 0|1 | ' +
          'scan <track> | attach <n> | detach | scroll <signed steps> | ' +
          'selectscene <index> | param\n',
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
  clearStatusWatch();
  clearMeterObservers();
  clearTransportObservers();
  clearSelObservers();
  clearChainObservers();
  chainWatching = false;
  chainTask.cancel();
  paramTask.cancel();
  paramPending = false;
  paramDirty = {};
  clearDiagObservers();
  diagDetach();
  diagScrollTask.cancel();
  diagSelectSceneTask.cancel();
  applyTask.cancel();
  moveTask.cancel();
  snapshotTask.cancel();
  snapJob = null;
  structureSettleTask.cancel();
  structuralJob = false;
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
