// The probe's [v8] runtime: reads gen~'s stats ring, accumulates, and speaks
// the probe↔bridge protocol over global sends.
//
// Nothing here touches a Max global. Buffer, Dict, Task, outlet and post all
// come in through `Host`, and the accumulator and coefficient maths through
// `Deps`, so the whole state machine runs under node:test with fakes.

import {
  H_EPOCH,
  H_HEAD,
  H_SR,
  HEAD_MOD,
  HEADER,
  CELLS,
  STRIDE,
  decodeBlock,
  cellFrame,
  splitHiLo,
  type Block,
} from './layout.ts';
import type { ProbeReport } from './report.ts';

export interface MaxBufferLike {
  /** Max JS Buffer: channel is 1-based; returns a number when count is 1, else an array. */
  peek(channel: number, frame: number, count: number): number | number[];
  poke(channel: number, frame: number, values: number | number[]): void;
}
export interface DictLike {
  parse(json: string): void;
}
export interface TaskLike {
  interval: number;
  repeat(count?: number): void;
  cancel(): void;
}
export type Atom = string | number;
export interface Host {
  /** May be null until the buffer~ exists; called lazily, every time. */
  statsBuffer(): MaxBufferLike | null;
  coefBuffer(): MaxBufferLike | null;
  newDict(name: string): DictLike;
  newTask(fn: () => void): TaskLike;
  outlet(index: number, atoms: Atom[]): void;
  post(message: string): void;
  /** [0, 1) */
  random(): number;
}
export interface AccumulatorLike {
  readonly sampleRate: number;
  add(block: Block): void;
  report(): ProbeReport;
}
export interface Deps {
  newAccumulator(sampleRate: number): AccumulatorLike;
  /** CO_SIZE doubles, CO_SR first. */
  coefficients(sampleRate: number): ArrayLike<number>;
}
export interface Probe {
  loaded(): void;
  liveid(id: number): void;
  storedkey(value: Atom): void;
  who(): void;
  listen(key: Atom, pass: Atom, on: Atom): void;
  rekey(liveId: Atom, newKey: Atom): void;
  /** The Task body, exposed for tests. */
  poll(): void;
}

export const POLL_MS = 100;
/** Polls per non-final report: about a second. */
export const REPORT_EVERY = 10;
/** Polls between `listen 0` and the final report. gen~ flushes its partial
 * block on the falling edge; this gives the audio thread time to do it. */
const STOP_POLLS = 2;
/** Report dicts kept referenced so Max doesn't free one before the bridge reads it. */
const KEEP_DICTS = 8;

const OUT_BRIDGE = 0;
const OUT_GEN = 1;
const OUT_PATTR = 2;
const OUT_BYE = 3;
const OUT_STATUS = 4;

type Mode = 'idle' | 'listening' | 'stopping';

/** What pattr holds when nothing was ever stored: 0, '0', '' or any number. */
function keyFrom(value: Atom): string | null {
  if (typeof value !== 'string') return null;
  if (value === '' || value === '0') return null;
  return value;
}

/** Max's peek returns a bare number for one frame; normalise. */
function frames(v: number | number[]): ArrayLike<number> {
  return typeof v === 'number' ? [v] : v;
}

export function createProbe(host: Host, deps: Deps): Probe {
  let key: string | null = null;
  let liveId: number | null = null;
  let isLoaded = false;
  let helloKey: string | null = null; // the key the last hello announced

  let mode: Mode = 'idle';
  let epoch = 0;
  let pass = 0;
  let acc: AccumulatorLike | null = null;
  let lastHead = 0;
  let pollsSinceReport = 0;
  let stopCountdown = 0;

  let lastSr = 0; // the latest rate gen~ reported, 0 until it has
  let coefSr = 0; // the rate the coefficient buffer was last written for
  let coefGen = 0;

  let dictSeq = 0;
  const dicts: DictLike[] = [];

  const task = host.newTask(() => guard(poll));

  /** Max shows a thrown error as a console line at best; post it and carry on. */
  function guard(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      host.post(`openflow-probe: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function makeKey(): string {
    // Starts with a letter so Max never parses the key as a number.
    let s = 'p';
    for (let i = 0; i < 11; i++) s += Math.floor(host.random() * 36).toString(36);
    return s;
  }

  /** Adopt a key: `store` writes it to pattr (not wanted when pattr gave it to us). */
  function setKey(next: string, store: boolean): void {
    key = next;
    if (store) host.outlet(OUT_PATTR, [next]);
    primeBye();
  }

  /**
   * freebang fires this box on unload, by which time the script may be gone, so
   * the message is kept ready in the patch. It carries the liveId as well as the
   * key: a copied probe deleted before its rekey shares the original's key, and
   * the liveId is what stops its bye from dropping the original.
   */
  function primeBye(): void {
    if (key === null || liveId === null) return;
    host.outlet(OUT_BYE, ['set', 'bye', key, liveId]);
  }

  function ready(): boolean {
    return isLoaded && key !== null && liveId !== null;
  }

  function hello(): void {
    if (!ready()) return;
    host.outlet(OUT_BRIDGE, ['hello', key as string, liveId as number]);
    helloKey = key;
  }

  /** Hello once ready, and again if pattr's stored key replaced the one we announced. */
  function maybeHello(): void {
    if (ready() && helloKey !== key) hello();
  }

  function send(final: boolean): void {
    // No accumulator means no sample rate was seen while listening. Report an
    // empty one at the last known rate (0 if none): the bridge gets an honest
    // zero-length pass instead of silence, and the accumulator's empty report
    // is NaN-free by contract.
    const report = (acc ?? deps.newAccumulator(lastSr)).report();
    // The liveId as well as the key: a duplicated probe shares its original's
    // key until the bridge rekeys it, and two probes must never write one dict.
    const name = `openflow-probe-${key}-${liveId ?? 0}-${++dictSeq}`;
    const dict = host.newDict(name);
    dict.parse(JSON.stringify(report));
    dicts.push(dict);
    if (dicts.length > KEEP_DICTS) dicts.shift();
    host.outlet(OUT_BRIDGE, ['report', key as string, pass, final ? 1 : 0, name]);
  }

  function writeCoefficients(sr: number): void {
    const buf = host.coefBuffer();
    if (!buf) return; // retried next poll: coefSr is still stale
    buf.poke(1, 0, splitHiLo(deps.coefficients(sr)));
    coefSr = sr;
    host.outlet(OUT_GEN, ['coefgen', ++coefGen]);
  }

  function ensureAccumulator(sr: number): void {
    if (acc && acc.sampleRate === sr) return;
    if (acc) host.post(`openflow-probe: sample rate changed to ${sr}; the pass restarts`);
    acc = deps.newAccumulator(sr);
  }

  function readBlocks(buf: MaxBufferLike, head: number): void {
    let count = lastHead;
    let fresh = (head - lastHead + HEAD_MOD) % HEAD_MOD;
    if (fresh > CELLS) {
      // gen~ lapped us: the oldest cells were overwritten. Read the newest CELLS.
      host.post(`openflow-probe: lost ${fresh - CELLS} blocks`);
      count = (head - CELLS + HEAD_MOD) % HEAD_MOD;
      fresh = CELLS;
    }
    for (let i = 0; i < fresh; i++) {
      // HEAD_MOD is a multiple of CELLS, so the cell survives the counter's wrap.
      const cell = count % CELLS;
      (acc as AccumulatorLike).add(decodeBlock(frames(buf.peek(1, cellFrame(cell), STRIDE))));
      count = (count + 1) % HEAD_MOD;
    }
    lastHead = head;
  }

  function read(): void {
    const buf = host.statsBuffer();
    if (!buf) return;
    const h = frames(buf.peek(1, 0, HEADER));
    const sr = h[H_SR];
    if (sr > 0) {
      lastSr = sr;
      if (sr !== coefSr) writeCoefficients(sr);
    }
    if (mode === 'idle' || !(sr > 0)) return;
    ensureAccumulator(sr);
    if (h[H_EPOCH] !== epoch) {
      // gen~ hasn't seen our epoch yet; what's in the ring belongs to the last pass.
      lastHead = 0;
      return;
    }
    readBlocks(buf, h[H_HEAD]);
  }

  function poll(): void {
    read();
    if (mode === 'listening') {
      if (++pollsSinceReport >= REPORT_EVERY) {
        pollsSinceReport = 0;
        send(false);
      }
    } else if (mode === 'stopping') {
      // Counts down even with no buffer, so a final report always arrives.
      if (--stopCountdown <= 0) {
        send(true);
        mode = 'idle';
        acc = null;
        host.outlet(OUT_STATUS, ['set', 'Idle']);
      }
    }
  }

  function start(nextPass: number): void {
    if (mode === 'stopping') {
      // The stopping pass was promised a final report, so it gets one now,
      // with whatever has reached the ring, rather than being silently
      // replaced. gen~'s flush of its last partial block may not have arrived
      // yet: at most 100 ms of a pass that has already ended.
      read();
      send(true);
    }
    epoch++;
    pass = nextPass;
    mode = 'listening';
    acc = null; // made on the next poll that knows the rate
    lastHead = 0;
    pollsSinceReport = 0;
    stopCountdown = 0;
    host.outlet(OUT_GEN, ['epoch', epoch]);
    host.outlet(OUT_GEN, ['listen', 1]);
    host.outlet(OUT_STATUS, ['set', 'Listening']);
  }

  function stop(): void {
    mode = 'stopping';
    stopCountdown = STOP_POLLS;
    host.outlet(OUT_GEN, ['listen', 0]);
  }

  return {
    loaded() {
      guard(() => {
        if (isLoaded) return;
        isLoaded = true;
        if (key === null) setKey(makeKey(), true);
        host.outlet(OUT_STATUS, ['set', 'Idle']);
        task.interval = POLL_MS;
        task.repeat();
        maybeHello();
      });
    },
    liveid(id) {
      guard(() => {
        const n = Number(id);
        // live.path reports id 0 for "no object"; that is not an identity.
        liveId = Number.isFinite(n) && n > 0 ? n : null;
        primeBye();
        maybeHello();
      });
    },
    storedkey(value) {
      guard(() => {
        const stored = keyFrom(value);
        // pattr echoes back what we store; a stored key equal to ours is that echo.
        if (stored === null || stored === key) return;
        setKey(stored, false);
        maybeHello();
      });
    },
    who() {
      guard(hello);
    },
    listen(k, p, on) {
      guard(() => {
        if (key === null || String(k) !== key) return;
        const n = Number(p);
        if (Number(on)) start(n);
        else if (mode === 'listening' && n === pass) stop();
      });
    },
    rekey(id, newKey) {
      guard(() => {
        if (liveId === null || Number(id) !== liveId) return;
        const next = keyFrom(String(newKey));
        if (next === null || next === key) return;
        setKey(next, true);
        helloKey = next; // the bridge chose this key; no hello needed
      });
    },
    poll() {
      guard(poll);
    },
  };
}
