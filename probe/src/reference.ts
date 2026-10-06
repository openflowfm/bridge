// The gen~ codebox (genexpr.ts) in TypeScript, statement for statement, so the
// tests can push known signals through the same per-sample algorithm and the
// same coefficients the device runs. Not shipped; nothing in the device
// imports it.
//
// It writes Blocks straight into an array instead of a ring: the ring and its
// head are device.ts's business and are tested there.

import { ST_BANDS, ST_KW, ST_SIZE, ST_TP, TP_HISTORY } from './genexpr.ts';
import {
  BAND_COUNT,
  blockLength,
  CO_BANDS,
  CO_KW,
  CO_SR,
  CO_TP,
  decodeBlock,
  F_BANDS,
  F_KL,
  F_KR,
  F_N,
  F_OVERS,
  F_SP,
  F_SUM_L,
  F_SUM_LL,
  F_SUM_LR,
  F_SUM_R,
  F_SUM_RR,
  F_TP,
  SECTIONS,
  STRIDE,
  TP_FACTOR,
  type Block,
} from './layout.ts';

export class GenMirror {
  readonly blocks: Block[] = [];
  private readonly co: Float64Array;
  private readonly st = new Float64Array(ST_SIZE);
  private readonly acc = new Float64Array(STRIDE);
  private readonly blockLen: number;
  private blk = 0;
  private tpW = 0;

  constructor(co: Float64Array) {
    this.co = co;
    this.blockLen = blockLength(co[CO_SR]);
  }

  private section(x: number, c: number, z: number): number {
    const { co, st } = this;
    const y = co[c] * x + st[z];
    st[z] = co[c + 1] * x - co[c + 3] * y + st[z + 1];
    st[z + 1] = co[c + 2] * x - co[c + 4] * y;
    return y;
  }

  private commit(): void {
    this.acc[F_N] = this.blk;
    this.blocks.push(decodeBlock(this.acc.slice()));
    this.acc.fill(0);
    this.blk = 0;
  }

  /** gen~'s falling-edge flush of a partial block. */
  flush(): void {
    if (this.blk > 0) this.commit();
  }

  process(left: ArrayLike<number>, right: ArrayLike<number>): void {
    const { co, st, acc } = this;
    for (let n = 0; n < left.length; n++) {
      const xL = left[n];
      const xR = right[n];

      const kL = this.section(this.section(xL, CO_KW, ST_KW), CO_KW + 5, ST_KW + 2);
      const kR = this.section(this.section(xR, CO_KW, ST_KW + 4), CO_KW + 5, ST_KW + 6);
      acc[F_KL] += kL * kL;
      acc[F_KR] += kR * kR;

      const aL = Math.abs(xL);
      const aR = Math.abs(xR);
      const sPeak = Math.max(aL, aR);
      acc[F_SP] = Math.max(acc[F_SP], sPeak);
      acc[F_OVERS] += (aL >= 1 ? 1 : 0) + (aR >= 1 ? 1 : 0);
      acc[F_SUM_L] += xL;
      acc[F_SUM_R] += xR;
      acc[F_SUM_LL] += xL * xL;
      acc[F_SUM_RR] += xR * xR;
      acc[F_SUM_LR] += xL * xR;

      st[ST_TP + this.tpW] = xL;
      st[ST_TP + TP_HISTORY + this.tpW] = xR;
      let tPeak = sPeak;
      for (let p = 0; p < TP_FACTOR; p++) {
        let yL = 0;
        let yR = 0;
        for (let k = 0; k < TP_HISTORY; k++) {
          const j = (this.tpW - k + TP_HISTORY) % TP_HISTORY;
          const h = co[CO_TP + TP_FACTOR * k + p];
          yL += h * st[ST_TP + j];
          yR += h * st[ST_TP + TP_HISTORY + j];
        }
        tPeak = Math.max(tPeak, Math.abs(yL), Math.abs(yR));
      }
      this.tpW = (this.tpW + 1) % TP_HISTORY;
      acc[F_TP] = Math.max(acc[F_TP], tPeak);

      const mid = (xL + xR) * 0.5;
      for (let b = 0; b < BAND_COUNT; b++) {
        let y = mid;
        for (let s = 0; s < SECTIONS; s++) {
          y = this.section(y, CO_BANDS + (b * SECTIONS + s) * 5, ST_BANDS + (b * SECTIONS + s) * 2);
        }
        acc[F_BANDS + b] += y * y;
      }

      if (++this.blk >= this.blockLen) this.commit();
    }
  }
}
