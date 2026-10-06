// BS.1770's K-weighting: a high shelf (+4 dB above ~1.7 kHz, modelling the
// head) followed by the RLB high-pass (~38 Hz).
//
// BS.1770 only publishes the coefficients for 48 kHz. Live runs at whatever
// rate the interface does, so the filters are re-derived from their analog
// parameters (f0, gain, Q) with the bilinear transform, the derivation
// libebur128 uses. The parameters were fitted so that at 48 kHz this
// reproduces the published coefficients to within 1e-6, which the tests check.

import type { Biquad } from "./biquad.ts";

/** [high-shelf pre-filter, RLB high-pass], BS.1770 stages 1 and 2, for any rate. */
export function kWeighting(sampleRate: number): [Biquad, Biquad] {
  return [shelf(sampleRate), highPass(sampleRate)];
}

function shelf(sampleRate: number): Biquad {
  const f0 = 1681.974450955533;
  const gainDb = 3.999843853973347;
  const q = 0.7071752369554196;
  const k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = 10 ** (gainDb / 20);
  // The band-edge gain the fit found; not quite √Vh, which a textbook shelf would use.
  const vb = vh ** 0.4996667741545416;
  const a0 = 1 + k / q + k * k;
  return {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
}

function highPass(sampleRate: number): Biquad {
  const f0 = 38.13547087602444;
  const q = 0.5003270373238773;
  const k = Math.tan((Math.PI * f0) / sampleRate);
  const a0 = 1 + k / q + k * k;
  // BS.1770 leaves the numerator unnormalised, [1, −2, 1]: its gain tends to
  // ~1.005 rather than 1 at high frequencies, and the −0.691 in the loudness
  // formula is calibrated against exactly this filter, so we keep it.
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
}
