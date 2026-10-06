// One second-order section, and the two things the tests and v8 need from a
// cascade of them: its magnitude response and a reference filter run.
//
// gen~ runs the same sections sample by sample; filter() is the TypeScript
// mirror of that loop, so the tests can run signals through the coefficients
// as well as check them by formula.

/** a0 normalised to 1: y = b0·x + b1·x₁ + b2·x₂ − a1·y₁ − a2·y₂. */
export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** Magnitude of the cascade at `hz`, in dB. */
export function responseDb(sections: readonly Biquad[], hz: number, sampleRate: number): number {
  const w = (2 * Math.PI * hz) / sampleRate;
  // z⁻¹ = e^{−jw}, z⁻² = e^{−j2w}.
  const c1 = Math.cos(w);
  const s1 = -Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = -Math.sin(2 * w);
  let power = 1;
  for (const q of sections) {
    const nr = q.b0 + q.b1 * c1 + q.b2 * c2;
    const ni = q.b1 * s1 + q.b2 * s2;
    const dr = 1 + q.a1 * c1 + q.a2 * c2;
    const di = q.a1 * s1 + q.a2 * s2;
    power *= (nr * nr + ni * ni) / (dr * dr + di * di);
  }
  return 10 * Math.log10(power);
}

/**
 * Run the cascade over `input` from silence. Transposed direct form II, the
 * form gen~ uses: two state variables per section, and it behaves well with
 * the poles close to the unit circle that the low bands have.
 */
export function filter(sections: readonly Biquad[], input: ArrayLike<number>): Float64Array {
  const out = Float64Array.from(input);
  for (const q of sections) {
    let s1 = 0;
    let s2 = 0;
    for (let n = 0; n < out.length; n++) {
      const x = out[n];
      const y = q.b0 * x + s1;
      s1 = q.b1 * x - q.a1 * y + s2;
      s2 = q.b2 * x - q.a2 * y;
      out[n] = y;
    }
  }
  return out;
}
