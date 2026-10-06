// The 31 third-octave band filters (IEC 61260 base-10 bands, 20 Hz … 20 kHz).
//
// Each band is a 6th-order Butterworth bandpass: a 3rd-order lowpass
// prototype, moved to the band by the LP→BP transform, then to the digital
// domain by the bilinear transform with both edges prewarped, so the −3 dB
// points land exactly on the band edges at any sample rate. Order 3 is what
// fits SECTIONS biquads, and it gives ≈18 dB at a neighbouring band's centre
// while adjacent bands still cross at −3 dB, so the bands' powers sum to
// roughly flat.
//
// The design is done in zero/pole/gain form rather than by expanding
// polynomials: a 20 Hz band at 192 kHz has poles within 1e-4 of the unit
// circle, and multiplying out a 6th-order denominator would lose them.

import { type Biquad, responseDb } from "./biquad.ts";
import { BAND_COUNT, SECTIONS } from "./layout.ts";

/** Exact base-10 centre of band i: 10^((i+13)/10) Hz, so band 17 is 1 kHz. */
export function bandCentre(i: number): number {
  return 10 ** ((i + 13) / 10);
}

/**
 * Band edges, half a band either side of the centre: centre·10^(∓1/20).
 *
 * The upper edge is clamped to 0.45·sampleRate. The 20 kHz band's nominal upper
 * edge is 22.4 kHz, past Nyquist at 44.1 kHz (and too close to it at 48 kHz
 * for the prewarp, whose tan() blows up at Nyquist). The clamped band is
 * narrower and centred lower, but it still measures the top of the spectrum.
 */
export function bandEdges(i: number, sampleRate: number): { lo: number; hi: number } {
  const centre = bandCentre(i);
  return {
    lo: centre * 10 ** (-1 / 20),
    hi: Math.min(centre * 10 ** (1 / 20), 0.45 * sampleRate),
  };
}

/** SECTIONS biquads for band i, unity gain at the geometric centre of its edges. */
export function bandSections(i: number, sampleRate: number): Biquad[] {
  if (!(i >= 0 && i < BAND_COUNT)) throw new RangeError(`band ${i} out of range`);
  const { lo, hi } = bandEdges(i, sampleRate);
  // Work in s / (2·fs) so the bilinear transform is z = (1 + s) / (1 − s);
  // the prewarped edges are then plain tangents.
  const wl = Math.tan((Math.PI * lo) / sampleRate);
  const wh = Math.tan((Math.PI * hi) / sampleRate);
  const w0sq = wl * wh;
  const bw = wh - wl;

  const sections: Biquad[] = [];
  for (let k = 0; k < SECTIONS; k++) {
    // The 3rd-order Butterworth prototype's poles, at 2π/3, π and 4π/3.
    const theta = (Math.PI * (2 * k + SECTIONS + 1)) / (2 * SECTIONS);
    const pr = Math.cos(theta);
    const pi = Math.abs(Math.sin(theta)) < 1e-12 ? 0 : Math.sin(theta); // the real pole is exactly real
    // LP→BP turns each prototype pole into two, one above the real axis and
    // one below (the band is narrow, so none is real). The six come in
    // conjugate pairs; keeping the three upper ones gives one pair per section.
    for (const s of bpRoots(pr, pi, bw, w0sq)) {
      if (s.im > 0) sections.push(sectionFromPole(s.re, s.im));
    }
  }
  if (sections.length !== SECTIONS) throw new Error(`band ${i}: expected ${SECTIONS} pole pairs`);

  // Zeros: the 3 at s = 0 go to z = +1, the 3 at s = ∞ go to z = −1, one of
  // each per section, so b = g·[1, 0, −1]. Each section gets its own g, so
  // each is unity at the centre: no section ever carries a huge gain that the
  // next has to undo, which matters for gen~'s state levels.
  const fc = Math.sqrt(lo * hi);
  return sections.map((q) => {
    const g = 1 / 10 ** (responseDb([{ ...q, b0: 1, b1: 0, b2: -1 }], fc, sampleRate) / 20);
    return { b0: g, b1: 0, b2: -g, a1: q.a1, a2: q.a2 };
  });
}

interface Complex {
  re: number;
  im: number;
}

/** Both roots of s² − p·B·s + ω0² = 0 for complex p. */
function bpRoots(pr: number, pi: number, bw: number, w0sq: number): Complex[] {
  const hr = (pr * bw) / 2;
  const hi = (pi * bw) / 2;
  // disc = h² − ω0²
  const dr = hr * hr - hi * hi - w0sq;
  const di = 2 * hr * hi;
  const sq = csqrt(dr, di);
  return [
    { re: hr + sq.re, im: hi + sq.im },
    { re: hr - sq.re, im: hi - sq.im },
  ];
}

function csqrt(re: number, im: number): Complex {
  const m = Math.hypot(re, im);
  const r = Math.sqrt((m + re) / 2);
  const i = Math.sqrt((m - re) / 2);
  return { re: r, im: im < 0 ? -i : i };
}

/** Denominator of a section from one analog pole (and its conjugate). */
function sectionFromPole(sr: number, si: number): Biquad {
  // z = (1 + s) / (1 − s), in s / (2·fs) units.
  const nr = 1 + sr;
  const dr = 1 - sr;
  const den = dr * dr + si * si;
  const zr = (nr * dr - si * si) / den;
  const zi = (nr * si + si * dr) / den;
  // (1 − z·z⁻¹)(1 − z̄·z⁻¹) = 1 − 2·Re z·z⁻¹ + |z|²·z⁻².
  // |z|² from the s form, ((1+σ)² + ω²) / ((1−σ)² + ω²), keeps 1 − |z|² accurate.
  return { b0: 0, b1: 0, b2: 0, a1: -2 * zr, a2: (nr * nr + si * si) / den };
}
