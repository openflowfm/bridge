// True peak per BS.1770 Annex 2: upsample 4× and take the largest |sample|.
//
// The interpolator is a Kaiser-windowed sinc, designed here rather than copied
// from the standard's example table. Choices:
//
// - 47 taps centred on tap 23, with tap 47 zero. The cutoff is exactly the
//   input Nyquist (π/4 at the upsampled rate), so the ideal sinc is zero at
//   every 4th tap from the centre: phase 3 is then a pure delay that returns
//   the input sample, and the other phases land at exactly ¼, ½ and ¾ between
//   samples. The ½ phase matters most, since that is where an fs/4 tone's
//   inter-sample peak sits.
// - β = 4. With only 12 taps per phase (what gen~ can afford per sample) the
//   window trades passband reach against image rejection. β = 4 keeps the
//   passband within ±0.2 dB up to 0.8×Nyquist and images ≥ 45 dB down from
//   1.25×Nyquist on. β = 5 or 6 droops 0.4–0.6 dB at 0.8×Nyquist (an
//   under-read of loud top-octave content) and, with the wider transition,
//   rejects less at 1.25×Nyquist; β = 3.5 gives up 4 dB of rejection.
// - Each phase is normalised to unity DC gain, so a constant reads exactly
//   itself on every phase rather than rippling by the window's leakage.

import { TP_FACTOR, TP_TAPS } from "./layout.ts";

const BETA = 4;

/** TP_TAPS taps; phase p at input time n is Σₖ taps[4k+p]·x[n−k]. */
export function truePeakTaps(): Float64Array {
  const taps = new Float64Array(TP_TAPS);
  const length = TP_TAPS - 1; // odd and symmetric; the last tap stays 0
  const centre = (length - 1) / 2;
  const i0Beta = besselI0(BETA);
  for (let m = 0; m < length; m++) {
    const t = m - centre;
    const r = t / centre;
    const window = besselI0(BETA * Math.sqrt(Math.max(0, 1 - r * r))) / i0Beta;
    taps[m] = sinc(t / TP_FACTOR) * window;
  }
  for (let p = 0; p < TP_FACTOR; p++) {
    let sum = 0;
    for (let m = p; m < TP_TAPS; m += TP_FACTOR) sum += taps[m];
    for (let m = p; m < TP_TAPS; m += TP_FACTOR) taps[m] /= sum;
  }
  return taps;
}

/**
 * The largest |x| of the 4× upsampled input, and never less than the largest
 * |x| of the input itself. This is the reference gen~'s true-peak loop mirrors.
 */
export function truePeak(input: ArrayLike<number>): number {
  const taps = truePeakTaps();
  const perPhase = TP_TAPS / TP_FACTOR;
  let peak = 0;
  for (let n = 0; n < input.length; n++) {
    peak = Math.max(peak, Math.abs(input[n]));
    for (let p = 0; p < TP_FACTOR; p++) {
      let y = 0;
      for (let k = 0; k < perPhase && k <= n; k++) y += taps[TP_FACTOR * k + p] * input[n - k];
      peak = Math.max(peak, Math.abs(y));
    }
  }
  return peak;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/** Modified Bessel function of the first kind, order 0, by its power series. */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 50; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}
