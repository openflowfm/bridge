// Blocks in, a cumulative ProbeReport out. Everything here runs at block rate
// (10 Hz) or report rate (1 Hz); the per-sample work already happened in gen~.
//
// Loudness follows BS.1770-4 (integrated, gated) and EBU Tech 3342 (LRA). The
// 100 ms block is the 400 ms gating block's 75 % hop, so each full block closes
// one gating block and one 3 s short-term window.

import { BAND_COUNT, BAND_HZ, blockLength, type Block } from "./layout.ts";
import { DB_FLOOR, amplitudeDb, powerDb, type ProbeBand, type ProbeReport } from "./report.ts";

/** Sub-blocks in a 400 ms gating block and in a 3 s short-term window. */
const GATE_BLOCKS = 4;
const SHORT_TERM_BLOCKS = 30;

const ABS_GATE = -70;
const REL_GATE_INTEGRATED = -10;
const REL_GATE_LRA = -20;

// LRA is P95 − P10 of the gated short-term values. Below 30 values the 95th
// percentile is decided by one or two values, so a single transient sets the
// range; 30 values is 3 s of short-term hop past the first window, the same span
// as the window itself, which is the least material Tech 3342's statistic means
// anything for.
const LRA_MIN_VALUES = 30;

// LRA histogram: 0.1 LU bins over [−70, +10). Above the top clamps into it.
const LRA_MIN = -70;
const LRA_STEP = 0.1;
const LRA_BINS = 800;

// Band level histogram: 0.5 dB bins over [−150, +30).
const BAND_MIN = DB_FLOOR;
const BAND_STEP = 0.5;
const BAND_BINS = 360;

/** BS.1770 loudness of a mean channel-weighted power, clamped at DB_FLOOR. */
function loudness(z: number): number {
  if (!(z > 0)) return DB_FLOOR;
  return Math.max(DB_FLOOR, -0.691 + 10 * Math.log10(z));
}

/** The power whose loudness is l: the inverse of loudness(). */
function loudnessPower(l: number): number {
  return Math.pow(10, (l + 0.691) / 10);
}

function binOf(value: number, min: number, step: number, bins: number): number {
  const i = Math.floor((value - min) / step);
  return i < 0 ? 0 : i >= bins ? bins - 1 : i;
}

/**
 * Index of the smallest bin whose cumulative count reaches p·total, or -1 when
 * total is 0. `from` lets the LRA skip the bins its relative gate removed.
 */
function percentileBin(counts: ArrayLike<number>, total: number, p: number, from = 0): number {
  if (total <= 0) return -1;
  const target = p * total;
  let cum = 0;
  for (let i = from; i < counts.length; i++) {
    cum += counts[i];
    if (cum >= target && cum > 0) return i;
  }
  return counts.length - 1;
}

/** Guard for the report: JSON has no NaN or Infinity. */
function finite(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback;
}

export class Accumulator {
  readonly sampleRate: number;
  private readonly fullLength: number;

  // Whole-signal sums, every block.
  private n = 0;
  private truePeak = 0;
  private samplePeak = 0;
  private overs = 0;
  private sumL = 0;
  private sumR = 0;
  private sumLL = 0;
  private sumRR = 0;
  private sumLR = 0;

  // The last SHORT_TERM_BLOCKS sub-block powers, a ring; `fullBlocks` counts all.
  private readonly recent = new Float64Array(SHORT_TERM_BLOCKS);
  private fullBlocks = 0;

  // Integrated loudness: gating-block powers that passed the absolute gate,
  // kept exactly because the relative gate moves as the window grows. The rest
  // can never pass, so they are not kept.
  private gated = new Float64Array(1024);
  private gatedCount = 0;
  private gatedSum = 0;

  // Short-term: the running max, and the LRA histogram of abs-gated values with
  // each bin's power sum so the relative gate's energy mean is exact.
  private shortTermMax = -Infinity;
  private readonly lraCounts = new Float64Array(LRA_BINS);
  private readonly lraPower = new Float64Array(LRA_BINS);
  private lraTotal = 0;
  private lraPowerSum = 0;

  // Bands: Σ bandSums and Σ n over full blocks, and a level histogram per band.
  private readonly bandSum = new Float64Array(BAND_COUNT);
  private bandN = 0;
  private readonly bandHist = new Float64Array(BAND_COUNT * BAND_BINS);

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.fullLength = blockLength(sampleRate);
  }

  add(block: Block): void {
    const n = block.n;
    if (!(n > 0)) return;
    this.n += n;
    if (block.truePeak > this.truePeak) this.truePeak = block.truePeak;
    if (block.samplePeak > this.samplePeak) this.samplePeak = block.samplePeak;
    this.overs += block.overs;
    this.sumL += block.sumL;
    this.sumR += block.sumR;
    this.sumLL += block.sumLL;
    this.sumRR += block.sumRR;
    this.sumLR += block.sumLR;

    // A short block is the flushed tail of a pass: its K-weighted and band sums
    // cover less than the 100 ms every gating window assumes, so it stays out.
    if (n !== this.fullLength) return;

    const p = block.kSumL / n + block.kSumR / n;
    this.recent[this.fullBlocks % SHORT_TERM_BLOCKS] = p;
    this.fullBlocks++;
    if (this.fullBlocks >= GATE_BLOCKS) this.closeGatingBlock(this.recentMean(GATE_BLOCKS));
    if (this.fullBlocks >= SHORT_TERM_BLOCKS) this.closeShortTerm(this.recentMean(SHORT_TERM_BLOCKS));

    this.bandN += n;
    for (let i = 0; i < BAND_COUNT; i++) {
      const s = block.bandSums[i];
      this.bandSum[i] += s;
      this.bandHist[i * BAND_BINS + binOf(powerDb(s / n), BAND_MIN, BAND_STEP, BAND_BINS)]++;
    }
  }

  report(): ProbeReport {
    const N = this.n;
    return {
      seconds: this.sampleRate > 0 ? N / this.sampleRate : 0,
      sampleRate: this.sampleRate,
      lufsIntegrated: this.integrated(),
      lufsShortTermMax: this.shortTermMax === -Infinity ? null : this.shortTermMax,
      loudnessRange: this.loudnessRange(),
      truePeakDb: amplitudeDb(this.truePeak),
      samplePeakDb: amplitudeDb(this.samplePeak),
      rmsDb: N > 0 ? powerDb((this.sumLL + this.sumRR) / (2 * N)) : DB_FLOOR,
      overSamples: finite(this.overs, 0),
      dcOffset: N > 0 ? finite((this.sumL + this.sumR) / (2 * N), 0) : 0,
      correlation: this.correlation(),
      bands: this.bands(),
    };
  }

  /** Mean of the last k sub-block powers. */
  private recentMean(k: number): number {
    let s = 0;
    for (let j = 1; j <= k; j++) s += this.recent[(this.fullBlocks - j) % SHORT_TERM_BLOCKS];
    return s / k;
  }

  private closeGatingBlock(z: number): void {
    if (!(loudness(z) > ABS_GATE)) return;
    if (this.gatedCount === this.gated.length) {
      const grown = new Float64Array(this.gated.length * 2);
      grown.set(this.gated);
      this.gated = grown;
    }
    this.gated[this.gatedCount++] = z;
    this.gatedSum += z;
  }

  private closeShortTerm(z: number): void {
    const l = loudness(z);
    if (l > this.shortTermMax) this.shortTermMax = l;
    if (!(l > ABS_GATE)) return;
    const bin = binOf(l, LRA_MIN, LRA_STEP, LRA_BINS);
    this.lraCounts[bin]++;
    this.lraPower[bin] += z;
    this.lraTotal++;
    this.lraPowerSum += z;
  }

  private integrated(): number | null {
    if (this.gatedCount === 0) return null;
    // Compare powers rather than taking a log per gating block: l > Γr ⇔ z > zr.
    const zr = loudnessPower(loudness(this.gatedSum / this.gatedCount) + REL_GATE_INTEGRATED);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < this.gatedCount; i++) {
      const z = this.gated[i];
      if (z > zr) {
        sum += z;
        count++;
      }
    }
    // The mean always exceeds mean − 10 LU, so count > 0; guard anyway.
    return count > 0 ? loudness(sum / count) : null;
  }

  private loudnessRange(): number | null {
    if (this.lraTotal === 0) return null;
    const gate = loudness(this.lraPowerSum / this.lraTotal) + REL_GATE_LRA;
    // Bins wholly or mostly above the gate survive: the bin's centre decides,
    // which places the gate to within half a bin (0.05 LU).
    const from = Math.max(0, Math.ceil((gate - LRA_MIN) / LRA_STEP - 0.5));
    let total = 0;
    for (let i = from; i < LRA_BINS; i++) total += this.lraCounts[i];
    if (total < LRA_MIN_VALUES) return null;
    const lo = percentileBin(this.lraCounts, total, 0.1, from);
    const hi = percentileBin(this.lraCounts, total, 0.95, from);
    return Math.max(0, (hi - lo) * LRA_STEP);
  }

  private correlation(): number {
    const N = this.n;
    if (N <= 0) return 1;
    const mL = this.sumL / N;
    const mR = this.sumR / N;
    const msL = this.sumLL / N;
    const msR = this.sumRR / N;
    const varL = msL - mL * mL;
    const varR = msR - mR * mR;
    // A channel with no variance (silence, or pure DC) has no correlation to
    // speak of; report it as mono-compatible. The threshold is relative so the
    // cancellation error of a large DC term doesn't read as signal.
    if (!(varL > Math.max(1e-24, 1e-9 * msL)) || !(varR > Math.max(1e-24, 1e-9 * msR))) return 1;
    const r = (this.sumLR / N - mL * mR) / Math.sqrt(varL * varR);
    if (!Number.isFinite(r)) return 1;
    return Math.max(-1, Math.min(1, r));
  }

  private bands(): ProbeBand[] {
    const out: ProbeBand[] = [];
    for (let i = 0; i < BAND_COUNT; i++) {
      const hist = this.bandHist.subarray(i * BAND_BINS, (i + 1) * BAND_BINS);
      out.push({
        hz: BAND_HZ[i],
        meanDb: this.bandN > 0 ? powerDb(this.bandSum[i] / this.bandN) : DB_FLOOR,
        floorDb: bandLevel(percentileBin(hist, this.fullBlocks, 0.1)),
        peakDb: bandLevel(percentileBin(hist, this.fullBlocks, 0.95)),
      });
    }
    return out;
  }
}

/** A band histogram bin's centre; bin 0 holds everything clamped to the floor. */
function bandLevel(bin: number): number {
  if (bin <= 0) return DB_FLOOR;
  return BAND_MIN + (bin + 0.5) * BAND_STEP;
}
