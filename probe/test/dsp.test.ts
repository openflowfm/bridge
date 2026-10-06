// The probe's filter design, checked against the standards and by running
// signals through it: K-weighting (BS.1770), the third-octave bands and the
// true-peak interpolator.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bandCentre, bandEdges, bandSections } from "../src/bands.ts";
import { type Biquad, filter, responseDb } from "../src/biquad.ts";
import { kWeighting } from "../src/kweight.ts";
import { BAND_COUNT, BAND_HZ, SECTIONS, TP_FACTOR, TP_TAPS } from "../src/layout.ts";
import { truePeak, truePeakTaps } from "../src/truepeak.ts";

const RATES = [44100, 48000, 96000, 192000];

function close(actual: number, expected: number, tol: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} not within ${tol} of ${expected}`);
}

/** Largest pole radius of z² + a1·z + a2. */
function poleRadius(q: Biquad): number {
  const disc = q.a1 * q.a1 - 4 * q.a2;
  if (disc < 0) return Math.sqrt(q.a2);
  const r = Math.sqrt(disc);
  return Math.max(Math.abs((-q.a1 + r) / 2), Math.abs((-q.a1 - r) / 2));
}

function sine(hz: number, sampleRate: number, n: number, amp = 1, phase = 0, fade = 0): Float64Array {
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // A raised-cosine fade-in keeps the onset from ringing the filters, which
    // would otherwise read as a peak the steady tone never has.
    const g = i < fade ? 0.5 - 0.5 * Math.cos((Math.PI * i) / fade) : 1;
    x[i] = amp * g * Math.sin((2 * Math.PI * hz * i) / sampleRate + phase);
  }
  return x;
}

const db = (x: number) => 20 * Math.log10(x);

describe("K-weighting", () => {
  it("reproduces BS.1770-4's published 48 kHz coefficients", () => {
    const [shelf, hp] = kWeighting(48000);
    close(shelf.b0, 1.53512485958697, 1e-6, "shelf b0");
    close(shelf.b1, -2.69169618940638, 1e-6, "shelf b1");
    close(shelf.b2, 1.19839281085285, 1e-6, "shelf b2");
    close(shelf.a1, -1.69065929318241, 1e-6, "shelf a1");
    close(shelf.a2, 0.73248077421585, 1e-6, "shelf a2");
    assert.deepEqual([hp.b0, hp.b1, hp.b2], [1, -2, 1]);
    close(hp.a1, -1.99004745483398, 1e-6, "high-pass a1");
    close(hp.a2, 0.99007225036621, 1e-6, "high-pass a2");
  });

  for (const sr of [44100, 48000, 96000]) {
    it(`reads ≈ +0.69 dB at 1 kHz and cuts hard at 10 Hz at ${sr} Hz`, () => {
      const k = kWeighting(sr);
      close(responseDb(k, 1000, sr), 0.691, 0.02, "1 kHz");
      assert.ok(responseDb(k, 10, sr) < -15, `10 Hz: ${responseDb(k, 10, sr)} dB`);
      // The shelf's +4 dB is what dominates the top end.
      close(responseDb(k, 10000, sr), 4.0, 0.3, "10 kHz");
    });
  }

  it("is stable at every rate", () => {
    for (const sr of RATES) for (const q of kWeighting(sr)) assert.ok(poleRadius(q) < 1, `${sr}`);
  });
});

describe("third-octave bands", () => {
  it("has 31 base-10 centres from ≈20 Hz to ≈20 kHz matching the nominal labels", () => {
    assert.equal(BAND_COUNT, 31);
    close(bandCentre(0), 19.95, 0.01, "lowest");
    close(bandCentre(17), 1000, 1e-9, "band 17");
    close(bandCentre(30), 19952.6, 0.1, "highest");
    // Each exact centre rounds to its ISO nominal label within 3%.
    for (let i = 0; i < BAND_COUNT; i++) close(bandCentre(i) / BAND_HZ[i], 1, 0.03, `band ${i}`);
  });

  for (const sr of [48000, 96000]) {
    it(`is 0 dB at each centre and −3 dB at each edge at ${sr} Hz`, () => {
      for (let i = 0; i < BAND_COUNT; i++) {
        const s = bandSections(i, sr);
        assert.equal(s.length, SECTIONS);
        const { lo, hi } = bandEdges(i, sr);
        close(responseDb(s, Math.sqrt(lo * hi), sr), 0, 0.01, `band ${i} centre`);
        close(responseDb(s, lo, sr), -3.01, 0.2, `band ${i} lower edge`);
        close(responseDb(s, hi, sr), -3.01, 0.2, `band ${i} upper edge`);
      }
    });

    it(`attenuates each neighbour's centre by ≥ 15 dB at ${sr} Hz`, () => {
      for (let i = 0; i < BAND_COUNT; i++) {
        const s = bandSections(i, sr);
        // A band clamped near Nyquist is wide after prewarping (tan() stretches
        // the top of the spectrum), so its lower skirt is gentler in Hz:
        // ≈14.6 dB at 16 kHz for the 20 kHz band at 48 kHz.
        const clamped = bandEdges(i, sr).hi < bandCentre(i) * 10 ** (1 / 20);
        const floor = clamped ? -14 : -15;
        if (i > 0) assert.ok(responseDb(s, bandCentre(i - 1), sr) <= floor, `band ${i} at band ${i - 1}`);
        if (i < BAND_COUNT - 1) assert.ok(responseDb(s, bandCentre(i + 1), sr) <= -15, `band ${i} at band ${i + 1}`);
      }
    });
  }

  it("is stable for every band at 44.1, 48, 96 and 192 kHz", () => {
    for (const sr of RATES) {
      for (let i = 0; i < BAND_COUNT; i++) {
        for (const q of bandSections(i, sr)) {
          const r = poleRadius(q);
          assert.ok(Number.isFinite(r) && r < 1, `band ${i} at ${sr} Hz: radius ${r}`);
        }
      }
    }
  });

  it("clamps the 20 kHz band below Nyquist at 44.1 kHz and keeps it usable", () => {
    const sr = 44100;
    const { lo, hi } = bandEdges(30, sr);
    close(hi, 0.45 * sr, 1e-9, "clamped edge");
    assert.ok(lo < hi);
    const s = bandSections(30, sr);
    for (const q of s) for (const v of Object.values(q)) assert.ok(Number.isFinite(v));
    close(responseDb(s, Math.sqrt(lo * hi), sr), 0, 0.01, "centre");
    // Not clamped where it fits.
    close(bandEdges(30, 96000).hi, bandCentre(30) * 10 ** (1 / 20), 1e-6, "96 kHz edge");
  });

  it("sums (in power) to within ±1.5 dB of flat from 25 Hz to 16 kHz at 48 kHz", () => {
    const sr = 48000;
    const all = Array.from({ length: BAND_COUNT }, (_, i) => bandSections(i, sr));
    for (let hz = 25; hz <= 16000; hz *= 1.01) {
      let power = 0;
      for (const s of all) power += 10 ** (responseDb(s, hz, sr) / 10);
      close(10 * Math.log10(power), 0, 1.5, `${hz.toFixed(1)} Hz`);
    }
  });

  it("passes a 1 kHz sine through the 1 kHz band at full amplitude", () => {
    for (const sr of [48000, 192000]) {
      const x = sine(1000, sr, sr / 2);
      const y = filter(bandSections(17, sr), x);
      // Measure the last 100 ms, long after the band has rung up.
      let sum = 0;
      const tail = y.subarray(y.length - sr / 10);
      for (const v of tail) sum += v * v;
      close(Math.sqrt(sum / tail.length), Math.SQRT1_2, 0.005, `RMS at ${sr} Hz`);
    }
  });

  it("filter() rejects a tone two bands away", () => {
    const sr = 48000;
    const x = sine(1000, sr, sr / 2);
    const y = filter(bandSections(15, sr), x); // 630 Hz band
    let peak = 0;
    for (const v of y.subarray(y.length - sr / 10)) peak = Math.max(peak, Math.abs(v));
    assert.ok(db(peak) < -30, `${db(peak)} dB`);
  });
});

describe("true peak", () => {
  it("has 48 taps whose phases each sum to 1", () => {
    const taps = truePeakTaps();
    assert.equal(taps.length, TP_TAPS);
    for (let p = 0; p < TP_FACTOR; p++) {
      let sum = 0;
      for (let m = p; m < TP_TAPS; m += TP_FACTOR) sum += taps[m];
      close(sum, 1, 0.01, `phase ${p}`);
    }
  });

  it("finds the inter-sample peak of an fs/4 sine at 45°", () => {
    const x = sine(12000, 48000, 480, 1, Math.PI / 4);
    let samplePeak = 0;
    for (const v of x) samplePeak = Math.max(samplePeak, Math.abs(v));
    close(samplePeak, Math.SQRT1_2, 1e-9, "sample peak");
    close(db(truePeak(x)), 0, 0.2, "true peak dB");
  });

  // The README's claim, exactly: a steady tone reads within ±0.2 dB up to
  // 0.8×Nyquist. (Measured: 0 to +0.1 dB.)
  it("reads steady sines from 100 Hz to 0.8×Nyquist within ±0.2 dB", () => {
    const sr = 48000;
    for (let hz = 100; hz <= 0.8 * (sr / 2); hz *= 1.05) {
      for (const phase of [0, 0.4, 1.3, 2.9]) {
        const d = db(truePeak(sine(hz, sr, 4800, 0.5, phase, 480)) / 0.5);
        assert.ok(Math.abs(d) <= 0.2, `${hz.toFixed(0)} Hz phase ${phase}: ${d.toFixed(3)} dB`);
      }
    }
  });

  // A single isolated crest can fall between two 4× points. The README states
  // the bound: 20·log10(cos(π·f / (4·fs))), −0.43 dB at 0.8×Nyquist. Place the
  // crest exactly midway between output points to hit it.
  it("under-reads an isolated crest by no more than the 4× grid allows", () => {
    const sr = 48000;
    const hz = 0.8 * (sr / 2);
    const n = 64;
    const centre = 32 + 1 / 8; // half a 4× step past a sample: worst case
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      // One cycle under a narrow raised-cosine bump: a lone peak, not a tone.
      const t = i - centre;
      const w = Math.abs(t) < 6 ? 0.5 + 0.5 * Math.cos((Math.PI * t) / 6) : 0;
      x[i] = 0.5 * w * Math.cos((2 * Math.PI * hz * t) / sr);
    }
    const bound = 20 * Math.log10(Math.cos((Math.PI * hz) / (4 * sr)));
    const d = db(truePeak(x) / 0.5);
    assert.ok(d >= bound - 0.15 && d <= 0.2, `${d.toFixed(3)} dB vs bound ${bound.toFixed(3)}`);
  });

  it("is never below the sample peak", () => {
    const x = new Float64Array([0, 0, 0, 0.9, 0, 0, 0]);
    assert.ok(truePeak(x) >= 0.9);
    assert.equal(truePeak([]), 0);
  });
});
