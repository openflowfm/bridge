import { test } from "node:test";
import assert from "node:assert/strict";

import { Accumulator } from "../src/accumulator.ts";
import { BAND_COUNT, BAND_HZ, blockLength, type Block } from "../src/layout.ts";
import { powerDb } from "../src/report.ts";

const SR = 48000;
const N = blockLength(SR);

interface Spec {
  n?: number;
  /** K-weighted mean square per channel. */
  kms?: number;
  /** Mean square per band, all bands. */
  bandMs?: number;
  truePeak?: number;
  samplePeak?: number;
  overs?: number;
  /** Per-sample mean, mean square and L·R mean. */
  meanL?: number;
  meanR?: number;
  msL?: number;
  msR?: number;
  msLR?: number;
}

/** A block of a stereo signal described by its per-sample statistics. */
function block(s: Spec = {}): Block {
  const n = s.n ?? N;
  const kms = s.kms ?? 0;
  return {
    n,
    kSumL: kms * n,
    kSumR: kms * n,
    truePeak: s.truePeak ?? 0,
    samplePeak: s.samplePeak ?? 0,
    overs: s.overs ?? 0,
    sumL: (s.meanL ?? 0) * n,
    sumR: (s.meanR ?? 0) * n,
    sumLL: (s.msL ?? 0) * n,
    sumRR: (s.msR ?? 0) * n,
    sumLR: (s.msLR ?? 0) * n,
    bandSums: new Float64Array(BAND_COUNT).fill((s.bandMs ?? 0) * n),
  };
}

/** Per-channel K-weighted mean square that reads `lufs` with both channels equal. */
function kmsFor(lufs: number): number {
  return Math.pow(10, (lufs + 0.691) / 10) / 2;
}

function feed(acc: Accumulator, seconds: number, lufs: number): void {
  const b = block({ kms: kmsFor(lufs) });
  for (let i = 0; i < Math.round(seconds * 10); i++) acc.add(b);
}

function near(actual: number | null, expected: number, tol: number): void {
  assert.ok(actual !== null, `expected ${expected}, got null`);
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${expected} ±${tol}, got ${actual}`);
}

test("empty accumulator reports zeros, nulls and the floor", () => {
  const r = new Accumulator(SR).report();
  assert.equal(r.seconds, 0);
  assert.equal(r.sampleRate, SR);
  assert.equal(r.lufsIntegrated, null);
  assert.equal(r.lufsShortTermMax, null);
  assert.equal(r.loudnessRange, null);
  assert.equal(r.truePeakDb, -150);
  assert.equal(r.samplePeakDb, -150);
  assert.equal(r.rmsDb, -150);
  assert.equal(r.overSamples, 0);
  assert.equal(r.dcOffset, 0);
  assert.equal(r.correlation, 1);
  assert.equal(r.bands.length, 31);
  assert.deepEqual(r.bands.map((b) => b.hz), BAND_HZ);
  for (const b of r.bands) assert.deepEqual([b.meanDb, b.floorDb, b.peakDb], [-150, -150, -150]);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test("all-zero blocks stay JSON-safe", () => {
  const acc = new Accumulator(SR);
  for (let i = 0; i < 50; i++) acc.add(block());
  const r = acc.report();
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  assert.equal(r.lufsIntegrated, null);
  assert.equal(r.lufsShortTermMax, -150);
  assert.equal(r.correlation, 1);
  for (const b of r.bands) assert.deepEqual([b.meanDb, b.floorDb, b.peakDb], [-150, -150, -150]);
});

test("steady level: integrated and short-term max", () => {
  const acc = new Accumulator(SR);
  const b = block({ kms: 0.005 });
  const expected = -0.691 + 10 * Math.log10(0.01);
  for (let i = 0; i < 3; i++) acc.add(b);
  assert.equal(acc.report().lufsIntegrated, null);
  acc.add(b);
  near(acc.report().lufsIntegrated, expected, 0.01);
  for (let i = 4; i < 29; i++) acc.add(b);
  assert.equal(acc.report().lufsShortTermMax, null);
  acc.add(b);
  near(acc.report().lufsShortTermMax, expected, 0.01);
  for (let i = 0; i < 100; i++) acc.add(b);
  const r = acc.report();
  near(r.lufsIntegrated, expected, 0.01);
  near(r.lufsShortTermMax, expected, 0.01);
  assert.equal(r.seconds, 13);
});

test("gating: Tech 3341 case 3 shape reads -23", () => {
  const acc = new Accumulator(SR);
  feed(acc, 10, -36);
  feed(acc, 60, -23);
  feed(acc, 10, -36);
  const r = acc.report();
  near(r.lufsIntegrated, -23, 0.1);
  near(r.lufsShortTermMax, -23, 0.01);
});

test("gating: the relative gate actually removes quiet passages", () => {
  // Ungated, 60 s at -23 and 60 s at -40 would read about -26.
  const acc = new Accumulator(SR);
  feed(acc, 60, -23);
  feed(acc, 60, -40);
  near(acc.report().lufsIntegrated, -23, 0.1);
});

test("gating: silence only reads null", () => {
  const acc = new Accumulator(SR);
  feed(acc, 10, -80);
  assert.equal(acc.report().lufsIntegrated, null);
});

test("LRA: Tech 3342 case 1 shape reads 10", () => {
  const acc = new Accumulator(SR);
  feed(acc, 20, -20);
  feed(acc, 20, -30);
  near(acc.report().loudnessRange, 10, 1);
});

test("LRA: case 2 shape reads 5", () => {
  const acc = new Accumulator(SR);
  feed(acc, 20, -20);
  feed(acc, 20, -15);
  near(acc.report().loudnessRange, 5, 1);
});

test("LRA: relative gate drops passages 20 LU down", () => {
  const acc = new Accumulator(SR);
  feed(acc, 20, -20);
  feed(acc, 20, -50);
  feed(acc, 20, -20);
  // Without the gate the range would be about 30 LU.
  const lra = acc.report().loudnessRange;
  assert.ok(lra !== null && lra < 15, `got ${lra}`);
});

test("LRA: null until 30 short-term values", () => {
  const acc = new Accumulator(SR);
  const b = block({ kms: kmsFor(-20) });
  for (let i = 0; i < 58; i++) acc.add(b); // 29 short-term values
  assert.equal(acc.report().loudnessRange, null);
  acc.add(b);
  near(acc.report().loudnessRange, 0, 0.05);
});

test("partial tail counts toward seconds and peaks, not loudness or bands", () => {
  const acc = new Accumulator(SR);
  for (let i = 0; i < 4; i++) acc.add(block({ kms: 0.005, bandMs: 1e-4 }));
  const before = acc.report();
  acc.add(block({ n: N / 2, kms: 0.5, bandMs: 1, truePeak: 0.9, samplePeak: 0.8, overs: 3 }));
  const r = acc.report();
  assert.equal(r.seconds, 0.45);
  near(r.truePeakDb, 20 * Math.log10(0.9), 1e-9);
  near(r.samplePeakDb, 20 * Math.log10(0.8), 1e-9);
  assert.equal(r.overSamples, 3);
  assert.equal(r.lufsIntegrated, before.lufsIntegrated);
  assert.deepEqual(r.bands, before.bands);
});

test("correlation from the sums", () => {
  const same = new Accumulator(SR);
  same.add(block({ msL: 0.1, msR: 0.1, msLR: 0.1 }));
  near(same.report().correlation, 1, 1e-12);

  const inverted = new Accumulator(SR);
  inverted.add(block({ msL: 0.1, msR: 0.1, msLR: -0.1 }));
  near(inverted.report().correlation, -1, 1e-12);

  const uncorrelated = new Accumulator(SR);
  uncorrelated.add(block({ msL: 0.1, msR: 0.1, msLR: 0 }));
  near(uncorrelated.report().correlation, 0, 1e-12);

  // Means are removed: a shared DC offset over independent signals is not correlation.
  const dc = new Accumulator(SR);
  dc.add(block({ meanL: 0.5, meanR: 0.5, msL: 0.35, msR: 0.35, msLR: 0.25 }));
  near(dc.report().correlation, 0, 1e-9);

  const silence = new Accumulator(SR);
  silence.add(block());
  assert.equal(silence.report().correlation, 1);
});

test("DC offset, overs, RMS and peaks from known sums", () => {
  const acc = new Accumulator(SR);
  acc.add(block({ meanL: 0.1, meanR: 0.3, msL: 0.01, msR: 0.03, overs: 2, truePeak: 1.2, samplePeak: 0.5 }));
  acc.add(block({ meanL: 0.1, meanR: 0.3, msL: 0.01, msR: 0.03, overs: 5, truePeak: 1.1, samplePeak: 0.6 }));
  const r = acc.report();
  near(r.dcOffset, 0.2, 1e-12);
  assert.equal(r.overSamples, 7);
  near(r.rmsDb, 10 * Math.log10(0.02), 1e-9);
  near(r.truePeakDb, 20 * Math.log10(1.2), 1e-9);
  near(r.samplePeakDb, 20 * Math.log10(0.6), 1e-9);
});

test("bands: floor, peak and mean of an alternating level", () => {
  const acc = new Accumulator(SR);
  for (let i = 0; i < 100; i++) acc.add(block({ bandMs: i % 10 === 0 ? 1e-1 : 1e-4 }));
  const r = acc.report();
  for (const b of r.bands) {
    near(b.floorDb, -40, 0.5);
    near(b.peakDb, -10, 0.5);
    near(b.meanDb, powerDb(0.9 * 1e-4 + 0.1 * 1e-1), 0.1);
  }
});
