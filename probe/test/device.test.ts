import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  POLL_MS,
  REPORT_EVERY,
  createProbe,
  type AccumulatorLike,
  type Atom,
  type Deps,
  type Host,
  type MaxBufferLike,
  type Probe,
} from '../src/device.ts';
import {
  CO_SIZE,
  COEF_FRAMES,
  F_N,
  H_EPOCH,
  H_HEAD,
  H_SR,
  HEAD_MOD,
  SLOTS,
  STATS_FRAMES,
  slotFrame,
  splitHiLo,
  type Block,
} from '../src/layout.ts';
import type { ProbeReport } from '../src/report.ts';

class FakeBuffer implements MaxBufferLike {
  data: Float64Array;
  pokes = 0;
  constructor(frames: number) {
    this.data = new Float64Array(frames);
  }
  peek(channel: number, frame: number, count: number): number | number[] {
    assert.equal(channel, 1);
    if (count === 1) return this.data[frame];
    return Array.from(this.data.subarray(frame, frame + count));
  }
  poke(channel: number, frame: number, values: number | number[]): void {
    assert.equal(channel, 1);
    this.pokes++;
    const vs = typeof values === 'number' ? [values] : values;
    // A float32 buffer~, as in Max.
    for (let i = 0; i < vs.length; i++) this.data[frame + i] = Math.fround(vs[i]);
  }
}

/** Counts blocks; reports the count as `seconds` and the samples as `overSamples`. */
class FakeAccumulator implements AccumulatorLike {
  readonly sampleRate: number;
  blocks: number[] = [];
  constructor(sr: number) {
    this.sampleRate = sr;
  }
  add(block: Block): void {
    this.blocks.push(block.n);
  }
  report(): ProbeReport {
    return {
      seconds: this.blocks.length,
      sampleRate: this.sampleRate,
      lufsIntegrated: null,
      lufsShortTermMax: null,
      loudnessRange: null,
      truePeakDb: -150,
      samplePeakDb: -150,
      rmsDb: -150,
      overSamples: this.blocks.reduce((a, b) => a + b, 0),
      dcOffset: 0,
      correlation: 0,
      bands: [],
    };
  }
}

interface Rig {
  probe: Probe;
  stats: FakeBuffer;
  coef: FakeBuffer;
  out: [number, Atom[]][];
  posts: string[];
  dicts: Map<string, unknown>;
  accs: FakeAccumulator[];
  task: { interval: number; repeats: number };
  statsMissing: boolean;
  /** Outlet messages since the last call, optionally only one outlet. */
  take(outlet?: number): Atom[][];
  /** gen~ writing block number `count` (of this epoch) with n samples. */
  write(count: number, n: number): void;
}

function rig(randoms: number[] = []): Rig {
  const stats = new FakeBuffer(STATS_FRAMES);
  const coef = new FakeBuffer(COEF_FRAMES);
  const out: [number, Atom[]][] = [];
  const posts: string[] = [];
  const dicts = new Map<string, unknown>();
  const accs: FakeAccumulator[] = [];
  const task = { interval: 0, repeats: 0 };
  let r = 0;
  const host: Host = {
    statsBuffer: () => (state.statsMissing ? null : stats),
    coefBuffer: () => coef,
    newDict: (name) => ({ parse: (json) => void dicts.set(name, JSON.parse(json)) }),
    newTask: () => ({
      get interval() {
        return task.interval;
      },
      set interval(v: number) {
        task.interval = v;
      },
      repeat: () => void task.repeats++,
      cancel: () => {},
    }),
    outlet: (i, atoms) => void out.push([i, atoms]),
    post: (m) => void posts.push(m),
    random: () => (r < randoms.length ? randoms[r++] : 0.5),
  };
  const deps: Deps = {
    newAccumulator: (sr) => {
      const a = new FakeAccumulator(sr);
      accs.push(a);
      return a;
    },
    coefficients: (sr) => Array.from({ length: CO_SIZE }, (_, i) => (i === 0 ? sr : 1 / (i + 3))),
  };
  let seen = 0;
  const state: Rig = {
    probe: createProbe(host, deps),
    stats,
    coef,
    out,
    posts,
    dicts,
    accs,
    task,
    statsMissing: false,
    take(outlet) {
      const fresh = out.slice(seen);
      seen = out.length;
      return fresh.filter(([i]) => outlet === undefined || i === outlet).map(([, a]) => a);
    },
    write(count, n) {
      stats.data[slotFrame(count % SLOTS) + F_N] = n;
      stats.data[H_HEAD] = (count + 1) % HEAD_MOD;
    },
  };
  return state;
}

/** A loaded probe with key 'pkey' and liveId 7, outlets drained. */
function ready(): Rig {
  const t = rig();
  t.probe.liveid(7);
  t.probe.storedkey('pkey');
  t.probe.loaded();
  t.take();
  return t;
}

/** Start pass `pass` and have gen~ mirror the epoch at 48 kHz. */
function listening(t: Rig, pass = 1): number {
  t.probe.listen('pkey', pass, 1);
  const epoch = t.take(1).find((m) => m[0] === 'epoch')?.[1] as number;
  t.stats.data[H_SR] = 48000;
  t.stats.data[H_EPOCH] = epoch;
  t.stats.data[H_HEAD] = 0;
  return epoch;
}

function blocksRead(t: Rig): number[] {
  return t.accs.flatMap((a) => a.blocks);
}

test('a fresh probe makes a key on loaded, stores it and primes bye', () => {
  const t = rig(Array.from({ length: 11 }, (_, i) => i / 36));
  t.probe.storedkey(0);
  t.probe.liveid(3);
  t.probe.loaded();
  assert.deepEqual(t.out.map(([i]) => i), [2, 3, 4, 0]);
  assert.deepEqual(t.take(), [
    ['p0123456789a'],
    ['set', 'bye', 'p0123456789a', 3],
    ['set', 'Idle'],
    ['hello', 'p0123456789a', 3],
  ]);
  assert.equal(t.task.interval, POLL_MS);
  assert.equal(t.task.repeats, 1);
});

test('bye is primed only once both key and liveId are known, and carries both', () => {
  const t = rig();
  t.probe.storedkey('pabc');
  assert.ok(!t.take(3).length); // no liveId yet: a bye without one could drop the original
  t.probe.liveid(12);
  assert.deepEqual(t.take(3), [['set', 'bye', 'pabc', 12]]);
});

test('a stored key is reused and the pattr echo is a no-op', () => {
  const t = rig();
  t.probe.storedkey('pabc');
  t.probe.liveid(9);
  t.probe.loaded();
  const msgs = t.take();
  assert.ok(!msgs.some((m) => m.length === 1)); // nothing written to pattr
  assert.deepEqual(
    msgs.filter((m) => m[0] === 'hello'),
    [['hello', 'pabc', 9]],
  );
  t.probe.storedkey('pabc');
  assert.deepEqual(t.take(), []);
  for (const none of [0, '0', '', 42] as Atom[]) t.probe.storedkey(none);
  assert.deepEqual(t.take(), []);
});

test('hello waits for loaded and liveid, in any order, and repeats on who', () => {
  const t = rig();
  t.probe.who();
  t.probe.storedkey('pk');
  t.probe.loaded();
  assert.ok(!t.take(0).length);
  t.probe.liveid(5);
  assert.deepEqual(t.take(0), [['hello', 'pk', 5]]);
  t.probe.liveid(5);
  assert.deepEqual(t.take(0), []);
  t.probe.who();
  t.probe.who();
  assert.deepEqual(t.take(0), [
    ['hello', 'pk', 5],
    ['hello', 'pk', 5],
  ]);
});

test('messages for other keys and liveIds are ignored', () => {
  const t = ready();
  t.probe.listen('pother', 1, 1);
  t.probe.rekey(8, 'pnew');
  t.probe.listen(12, 1, 1);
  assert.deepEqual(t.take(), []);
});

test('listen 1 bumps the epoch and arms gen~; a second listen 1 restarts', () => {
  const t = ready();
  t.probe.listen('pkey', 4, 1);
  assert.deepEqual(t.take(), [
    ['epoch', 1],
    ['listen', 1],
    ['set', 'Listening'],
  ]);
  t.probe.listen('pkey', '5', 1);
  assert.deepEqual(t.take(1), [
    ['epoch', 2],
    ['listen', 1],
  ]);
});

test('blocks are read once, only after gen~ mirrors the epoch', () => {
  const t = ready();
  t.probe.listen('pkey', 1, 1);
  t.stats.data[H_SR] = 48000;
  t.stats.data[H_EPOCH] = 0; // stale: last pass's blocks are still in the ring
  t.stats.data[H_HEAD] = 50;
  t.probe.poll();
  assert.deepEqual(blocksRead(t), []);
  t.stats.data[H_EPOCH] = 1;
  t.stats.data[H_HEAD] = 0;
  t.write(0, 10);
  t.write(1, 11);
  t.probe.poll();
  t.probe.poll();
  t.write(2, 12);
  t.probe.poll();
  assert.deepEqual(blocksRead(t), [10, 11, 12]);
});

test('the head counter wraps at HEAD_MOD without losing or repeating a block', () => {
  const t = ready();
  listening(t);
  // Walk the reader up to just short of the wrap, SLOTS at a time.
  let c = 0;
  while (c < HEAD_MOD - 3) {
    const step = Math.min(SLOTS, HEAD_MOD - 3 - c);
    for (let i = 0; i < step; i++) t.write(c++, 1);
    t.probe.poll();
  }
  const before = blocksRead(t).length;
  assert.equal(before, HEAD_MOD - 3);
  for (let i = 0; i < 6; i++) t.write(c++, 100 + i);
  assert.equal(t.stats.data[H_HEAD], 3);
  t.probe.poll();
  assert.deepEqual(blocksRead(t).slice(before), [100, 101, 102, 103, 104, 105]);
  assert.deepEqual(t.posts, []);
});

test('an overrun skips the lost blocks and reads the newest SLOTS', () => {
  const t = ready();
  listening(t);
  for (let c = 0; c < SLOTS + 5; c++) t.write(c, c);
  t.probe.poll();
  const got = blocksRead(t);
  assert.equal(got.length, SLOTS);
  assert.equal(got[0], 5);
  assert.equal(got[SLOTS - 1], SLOTS + 4);
  assert.match(t.posts.join('\n'), /lost 5 blocks/);
});

test('a missing stats buffer skips the poll without throwing', () => {
  const t = ready();
  listening(t);
  t.write(0, 1);
  t.statsMissing = true;
  t.probe.poll();
  assert.deepEqual(blocksRead(t), []);
  t.statsMissing = false;
  t.probe.poll();
  assert.deepEqual(blocksRead(t), [1]);
  assert.deepEqual(t.posts, []);
});

test('reports go out every REPORT_EVERY polls with unique dicts holding the JSON', () => {
  const t = ready();
  listening(t, 3);
  t.take();
  const names: string[] = [];
  for (let p = 1; p <= REPORT_EVERY * 3; p++) {
    t.write(p - 1, 1);
    t.probe.poll();
    const reports = t.take(0);
    if (p % REPORT_EVERY === 0) {
      assert.equal(reports.length, 1, `poll ${p}`);
      const [verb, key, pass, final, name] = reports[0];
      assert.deepEqual([verb, key, pass, final], ['report', 'pkey', 3, 0]);
      names.push(name as string);
      const r = t.dicts.get(name as string) as ProbeReport;
      assert.equal(r.seconds, p);
      assert.equal(r.sampleRate, 48000);
    } else assert.deepEqual(reports, [], `poll ${p}`);
  }
  assert.equal(new Set(names).size, 3);
  assert.ok(names.every((n) => n.startsWith('openflow-probe-pkey-')));
});

test('listen 0 for another pass, or when idle, is ignored', () => {
  const t = ready();
  t.probe.listen('pkey', 1, 0);
  assert.deepEqual(t.take(), []);
  listening(t, 2);
  t.take();
  t.probe.listen('pkey', 1, 0);
  assert.deepEqual(t.take(), []);
});

test('listen 0 stops gen~ and the final report comes two polls later, then nothing', () => {
  const t = ready();
  listening(t, 2);
  t.write(0, 1);
  t.probe.poll();
  t.take();
  t.probe.listen('pkey', '2', 0);
  assert.deepEqual(t.take(), [['listen', 0]]);
  t.probe.poll();
  assert.deepEqual(t.take(0), []);
  t.write(1, 7); // gen~'s flushed tail
  t.probe.poll();
  const [report] = t.take(0);
  assert.deepEqual(report.slice(0, 4), ['report', 'pkey', 2, 1]);
  assert.equal((t.dicts.get(report[4] as string) as ProbeReport).seconds, 2);
  assert.deepEqual(blocksRead(t), [1, 7]);
  for (let i = 0; i < REPORT_EVERY * 2; i++) t.probe.poll();
  assert.deepEqual(t.take(0), []);
  assert.deepEqual(t.out.at(-1)?.[1], ['set', 'Idle']);
});

test('a final report with no sample rate seen is an empty, NaN-free report', () => {
  const t = ready();
  t.probe.listen('pkey', 1, 1);
  t.probe.listen('pkey', 1, 0);
  t.probe.poll();
  t.probe.poll();
  const [report] = t.take(0);
  assert.deepEqual(report.slice(0, 4), ['report', 'pkey', 1, 1]);
  const r = t.dicts.get(report[4] as string) as ProbeReport;
  assert.equal(r.seconds, 0);
  assert.equal(r.sampleRate, 0);
});

test('coefficients are poked as hi/lo pairs with a coefgen when the rate appears or changes', () => {
  const t = ready();
  t.probe.poll();
  assert.deepEqual(t.take(1), []); // no rate yet
  t.stats.data[H_SR] = 44100;
  t.probe.poll();
  t.probe.poll();
  assert.deepEqual(t.take(1), [['coefgen', 1]]);
  const want = splitHiLo(Array.from({ length: CO_SIZE }, (_, i) => (i === 0 ? 44100 : 1 / (i + 3))));
  assert.deepEqual(Array.from(t.coef.data), want);
  assert.equal(t.coef.pokes, 1);
  t.stats.data[H_SR] = 96000;
  t.probe.poll();
  assert.deepEqual(t.take(1), [['coefgen', 2]]);
  assert.equal(t.coef.data[0], 96000);
});

test('a rate change mid-pass starts a fresh accumulator and says so', () => {
  const t = ready();
  listening(t);
  t.write(0, 1);
  t.probe.poll();
  t.stats.data[H_SR] = 44100;
  t.write(1, 2);
  t.probe.poll();
  assert.deepEqual(
    t.accs.map((a) => [a.sampleRate, a.blocks]),
    [
      [48000, [1]],
      [44100, [2]],
    ],
  );
  assert.match(t.posts.join('\n'), /sample rate changed/);
});

test('rekey adopts the new key, stores it, re-primes bye, sends no hello, keeps listening', () => {
  const t = ready();
  listening(t, 6);
  t.take();
  t.probe.rekey('7', 'pnew');
  assert.deepEqual(t.take(), [['pnew'], ['set', 'bye', 'pnew', 7]]);
  t.probe.listen('pkey', 6, 0);
  assert.deepEqual(t.take(), []);
  t.probe.storedkey('pnew'); // pattr's echo
  assert.deepEqual(t.take(), []);
  t.probe.listen('pnew', 6, 0);
  assert.deepEqual(t.take(), [['listen', 0]]);
  t.probe.who();
  assert.deepEqual(t.take(0), [['hello', 'pnew', 7]]);
});
