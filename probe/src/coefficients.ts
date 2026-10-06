// Every coefficient gen~ runs with, for one sample rate, in `Data co` order
// (layout.ts). v8 calls this when gen~ reports a rate it has no coefficients
// for; the reference processor calls it so tests run the same numbers.

import { bandSections } from './bands.ts';
import type { Biquad } from './biquad.ts';
import { kWeighting } from './kweight.ts';
import {
  BAND_COUNT,
  CO_BANDS,
  CO_KW,
  CO_SIZE,
  CO_SR,
  CO_TP,
  SECTIONS,
  TP_TAPS,
} from './layout.ts';
import { truePeakTaps } from './truepeak.ts';

function put(out: Float64Array, at: number, q: Biquad): void {
  out[at] = q.b0;
  out[at + 1] = q.b1;
  out[at + 2] = q.b2;
  out[at + 3] = q.a1;
  out[at + 4] = q.a2;
}

export function coefficients(sampleRate: number): Float64Array {
  const out = new Float64Array(CO_SIZE);
  out[CO_SR] = sampleRate;
  const [shelf, highpass] = kWeighting(sampleRate);
  put(out, CO_KW, shelf);
  put(out, CO_KW + 5, highpass);
  for (let b = 0; b < BAND_COUNT; b++) {
    const sections = bandSections(b, sampleRate);
    if (sections.length !== SECTIONS) throw new Error(`band ${b}: ${sections.length} sections`);
    for (let s = 0; s < SECTIONS; s++) put(out, CO_BANDS + (b * SECTIONS + s) * 5, sections[s]);
  }
  const taps = truePeakTaps();
  for (let i = 0; i < TP_TAPS; i++) out[CO_TP + i] = taps[i];
  return out;
}
