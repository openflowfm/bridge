// Known signals through the whole measuring path: the coefficients v8 writes
// (through the float32 hi/lo split gen~ reads them back from), the mirror of
// the gen~ codebox, and the accumulator that builds the report.

import assert from 'node:assert/strict';
import test from 'node:test';
import { Accumulator } from '../src/accumulator.ts';
import { coefficients } from '../src/coefficients.ts';
import { genCode } from '../src/genexpr.ts';
import { BAND_HZ, CO_SIZE, splitHiLo } from '../src/layout.ts';
import { GenMirror } from '../src/reference.ts';
import type { ProbeReport } from '../src/report.ts';

/** What gen~'s `Data co` holds after copying the float32 pairs back together. */
function loaded(sampleRate: number): Float64Array {
  const pairs = splitHiLo(coefficients(sampleRate)).map((v) => Math.fround(v));
  const co = new Float64Array(CO_SIZE);
  for (let i = 0; i < CO_SIZE; i++) co[i] = pairs[2 * i] + pairs[2 * i + 1];
  return co;
}

function measure(
  sampleRate: number,
  seconds: number,
  gen: (n: number) => [number, number],
): ProbeReport {
  const mirror = new GenMirror(loaded(sampleRate));
  const chunk = 4096;
  const total = Math.round(seconds * sampleRate);
  const l = new Float64Array(chunk);
  const r = new Float64Array(chunk);
  for (let at = 0; at < total; at += chunk) {
    const len = Math.min(chunk, total - at);
    for (let i = 0; i < len; i++) [l[i], r[i]] = gen(at + i);
    mirror.process(l.subarray(0, len), r.subarray(0, len));
  }
  mirror.flush();
  const acc = new Accumulator(sampleRate);
  for (const b of mirror.blocks) acc.add(b);
  return acc.report();
}

const sine = (sr: number, hz: number, amp: number, phase = 0) => (n: number) => {
  const v = amp * Math.sin((2 * Math.PI * hz * n) / sr + phase);
  return [v, v] as [number, number];
};

for (const sr of [44100, 48000, 96000]) {
  test(`1 kHz stereo sine at -20 dBFS reads -20 LUFS at ${sr} Hz (BS.1770)`, () => {
    const rep = measure(sr, 8, sine(sr, 1000, 0.1));
    assert.ok(rep.lufsIntegrated !== null);
    assert.ok(Math.abs(rep.lufsIntegrated + 20) < 0.1, `integrated ${rep.lufsIntegrated}`);
    assert.ok(Math.abs((rep.lufsShortTermMax as number) + 20) < 0.1);
    assert.ok(Math.abs(rep.samplePeakDb + 20) < 0.01);
    assert.ok(Math.abs(rep.truePeakDb + 20) < 0.1);
    assert.ok(Math.abs(rep.rmsDb + 23.01) < 0.02, `rms ${rep.rmsDb}`);
    assert.ok(Math.abs(rep.correlation - 1) < 1e-9);
    assert.ok(Math.abs(rep.dcOffset) < 1e-4);
    assert.equal(rep.overSamples, 0);
    assert.ok(Math.abs(rep.seconds - 8) < 1e-9);
    assert.equal(rep.sampleRate, sr);
    // The energy sits in the 1 kHz band; its neighbours are well down.
    const k = BAND_HZ.indexOf(1000);
    assert.ok(Math.abs(rep.bands[k].meanDb + 23.01) < 0.2, `band ${rep.bands[k].meanDb}`);
    assert.ok(rep.bands[k - 1].meanDb < rep.bands[k].meanDb - 15);
    assert.ok(rep.bands[k + 1].meanDb < rep.bands[k].meanDb - 15);
  });
}

test('EBU Tech 3341 case 3: -36/-23/-36 dBFS gates to -23 LUFS', () => {
  const sr = 48000;
  const amp = (db: number) => Math.pow(10, db / 20);
  const rep = measure(sr, 80, (n) => {
    const t = n / sr;
    const a = t < 10 || t >= 70 ? amp(-36) : amp(-23);
    const v = a * Math.sin((2 * Math.PI * 1000 * n) / sr);
    return [v, v];
  });
  assert.ok(Math.abs((rep.lufsIntegrated as number) + 23) < 0.1, `${rep.lufsIntegrated}`);
});

test('EBU Tech 3342 case 1: 20 s at -20 then 20 s at -30 is 10 LU of range', () => {
  const sr = 48000;
  const rep = measure(sr, 40, (n) => {
    const a = n < 20 * sr ? 0.1 : 0.1 * Math.pow(10, -10 / 20);
    const v = a * Math.sin((2 * Math.PI * 1000 * n) / sr);
    return [v, v];
  });
  assert.ok(Math.abs((rep.loudnessRange as number) - 10) < 1, `${rep.loudnessRange}`);
});

test('pink noise gives a flat band response', () => {
  const sr = 48000;
  // Paul Kellet's refined pink filter over a seeded white source.
  let seed = 12345;
  const white = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 31 - 1;
  };
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  const rep = measure(sr, 40, () => {
    const w = white();
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const v = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.05;
    b6 = w * 0.115926;
    return [v, v];
  });
  // 25 Hz … 16 kHz: below that the band is narrower than the pink filter's
  // accuracy, above it the 20 kHz band is clamped short of Nyquist.
  const means = rep.bands.slice(1, 30).map((b) => b.meanDb);
  const avg = means.reduce((a, b) => a + b) / means.length;
  for (const [i, m] of means.entries()) {
    assert.ok(Math.abs(m - avg) < 1.5, `${BAND_HZ[i + 1]} Hz: ${m.toFixed(2)} vs ${avg.toFixed(2)}`);
  }
  // A steady noise: the floor and peak straddle the mean closely.
  const mid = rep.bands[BAND_HZ.indexOf(1000)];
  assert.ok(mid.floorDb < mid.meanDb && mid.meanDb < mid.peakDb);
  assert.ok(mid.peakDb - mid.floorDb < 6);
});

test('an inter-sample peak reads above the sample peak', () => {
  const sr = 48000;
  // fs/4 at 45°: every sample lands at ±0.354, the waveform peaks at 0.5.
  const rep = measure(sr, 2, sine(sr, sr / 4, 0.5, Math.PI / 4));
  assert.ok(Math.abs(rep.samplePeakDb - 20 * Math.log10(0.5 * Math.SQRT1_2)) < 0.01);
  assert.ok(Math.abs(rep.truePeakDb - 20 * Math.log10(0.5)) < 0.2, `tp ${rep.truePeakDb}`);
});

test('overs, DC and anti-phase', () => {
  const sr = 48000;
  // Half the time at ±1.2 (over on both channels), half at ∓0.8 (not over).
  const antiPhase = measure(sr, 1, (n) => {
    const v = n % 100 < 50 ? 1.2 : -0.8;
    return [v, -v];
  });
  assert.equal(antiPhase.overSamples, sr);
  assert.ok(Math.abs(antiPhase.dcOffset) < 1e-9);
  assert.ok(Math.abs(antiPhase.correlation + 1) < 1e-9);
  // The same wave on both channels: a 0.2 DC offset, perfectly correlated.
  const inPhase = measure(sr, 1, (n) => {
    const v = n % 100 < 50 ? 1.2 : -0.8;
    return [v, v];
  });
  assert.ok(Math.abs(inPhase.dcOffset - 0.2) < 1e-9);
  assert.ok(Math.abs(inPhase.correlation - 1) < 1e-9);
});

test('silence: nulls where nothing was heard and -150 everywhere else', () => {
  const rep = measure(48000, 5, () => [0, 0]);
  assert.equal(rep.lufsIntegrated, null);
  assert.equal(rep.lufsShortTermMax, -150);
  assert.equal(rep.truePeakDb, -150);
  assert.equal(rep.correlation, 1);
  for (const b of rep.bands) assert.equal(b.meanDb, -150);
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(rep))), JSON.stringify(rep));
});

test('the gen~ codebox is generated whole', () => {
  const code = genCode();
  assert.equal(code, genCode());
  assert.doesNotMatch(code, /undefined|NaN|\$\{/);
  const open = code.split('{').length;
  assert.equal(open, code.split('}').length);
  assert.equal(code.split('(').length, code.split(')').length);
});
