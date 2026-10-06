// Where gen~ and the probe's [v8] script meet: two buffer~s, laid out here once.
//
// gen~ does the per-sample work and nothing else. Every 100 ms it writes one
// *block* of sums into the stats ring; v8 reads the ring ten times a second and
// does everything that is not per-sample — gating, percentiles, the report.
// Going the other way, v8 computes the filter coefficients for Live's sample
// rate and writes them into the coefficient buffer, which gen~ copies into a
// 64-bit Data when told to.
//
// gen~'s codebox is generated from these constants (genexpr.ts) and v8 reads
// with them (device.ts), so the two cannot disagree about an offset.

// ---------------------------------------------------------------------------
// The stats ring
// ---------------------------------------------------------------------------

/** Header frames at the start of the stats buffer. */
export const H_HEAD = 0; // count of blocks written this epoch, mod HEAD_MOD
export const H_EPOCH = 1; // the epoch gen~ last reset to
export const H_SR = 2; // gen~'s samplerate
export const H_COEF_SR = 3; // the sample rate the loaded coefficients were made for
export const H_BLOCK_LEN = 4; // samples in a full block at that rate
export const HEADER = 8;

/** Fields of one block, relative to its slot. */
export const F_N = 0; // samples in this block (a full block, or the flushed tail)
export const F_KL = 1; // Σ K-weighted left²
export const F_KR = 2; // Σ K-weighted right²
export const F_TP = 3; // max |x| of the 4× oversampled signal, either channel
export const F_SP = 4; // max |x|, either channel
export const F_OVERS = 5; // samples with |x| ≥ 1, per channel, summed
export const F_SUM_L = 6;
export const F_SUM_R = 7;
export const F_SUM_LL = 8;
export const F_SUM_RR = 9;
export const F_SUM_LR = 10;
export const F_BANDS = 11; // BAND_COUNT sums of the band-filtered mid signal, squared
export const BAND_COUNT = 31;
export const STRIDE = 48;

/** The ISO 266 nominal centres the report labels the bands with, lowest first. */
export const BAND_HZ: readonly number[] = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000,
  1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
];

/** Blocks the ring holds: 12.8 s of slack before a stalled reader loses any. */
export const SLOTS = 128;
/** The head counter wraps here, well inside float32's exact integers. */
export const HEAD_MOD = 65536;

export const STATS_FRAMES = HEADER + SLOTS * STRIDE;

/** Block length in seconds — BS.1770's 400 ms gating block is four of these. */
export const BLOCK_SECONDS = 0.1;

export function blockLength(sampleRate: number): number {
  return Math.round(sampleRate * BLOCK_SECONDS);
}

export function slotFrame(slot: number): number {
  return HEADER + slot * STRIDE;
}

/** One block as v8 reads it back. */
export interface Block {
  n: number;
  kSumL: number;
  kSumR: number;
  truePeak: number;
  samplePeak: number;
  overs: number;
  sumL: number;
  sumR: number;
  sumLL: number;
  sumRR: number;
  sumLR: number;
  /** BAND_COUNT sums of squares of the band-filtered (L+R)/2. */
  bandSums: ArrayLike<number>;
}

export function decodeBlock(frames: ArrayLike<number>): Block {
  const bandSums = new Float64Array(BAND_COUNT);
  for (let i = 0; i < BAND_COUNT; i++) bandSums[i] = frames[F_BANDS + i];
  return {
    n: frames[F_N],
    kSumL: frames[F_KL],
    kSumR: frames[F_KR],
    truePeak: frames[F_TP],
    samplePeak: frames[F_SP],
    overs: frames[F_OVERS],
    sumL: frames[F_SUM_L],
    sumR: frames[F_SUM_R],
    sumLL: frames[F_SUM_LL],
    sumRR: frames[F_SUM_RR],
    sumLR: frames[F_SUM_LR],
    bandSums,
  };
}

// ---------------------------------------------------------------------------
// The coefficients
// ---------------------------------------------------------------------------
//
// Indexes into gen~'s 64-bit `Data co`. **The buffer~ carrying them is float32**,
// which is not enough: a 20 Hz third-octave section at 192 kHz has poles within
// 1e-4 of the unit circle, and rounding a1 to float32 moves the band by several
// percent. So each coefficient crosses as two frames, a float32 `hi` and the
// float32 remainder `lo`, and gen~ adds them back together once, on load.

export const CO_SR = 0;
/** K-weighting: the shelf then the high-pass, each b0 b1 b2 a1 a2. */
export const CO_KW = 1;
/** BAND_COUNT bands × SECTIONS biquads × 5, lowest band first. */
export const CO_BANDS = CO_KW + 10;
export const SECTIONS = 3;
/** The 4× true-peak interpolator: TP_TAPS taps, phase p uses taps p, p+4, p+8 … */
export const CO_TP = CO_BANDS + BAND_COUNT * SECTIONS * 5;
export const TP_FACTOR = 4;
export const TP_TAPS = 48;
export const CO_SIZE = CO_TP + TP_TAPS;

/** Frames in the coefficient buffer~: a hi/lo pair per coefficient. */
export const COEF_FRAMES = CO_SIZE * 2;

/** Split doubles into float32 hi/lo pairs, interleaved, for the coefficient buffer~. */
export function splitHiLo(values: ArrayLike<number>): number[] {
  const out: number[] = new Array(values.length * 2);
  for (let i = 0; i < values.length; i++) {
    const hi = Math.fround(values[i]);
    out[2 * i] = hi;
    out[2 * i + 1] = Math.fround(values[i] - hi);
  }
  return out;
}
