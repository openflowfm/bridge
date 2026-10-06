// The report a probe sends, field for field `OpenFlow.ProbeReport` and
// `OpenFlow.ProbeBand` from @openflow/protocol (global.d.ts, protocol#6).
//
// Spelled out here rather than read from the global namespace because the
// protocol this repo pins predates the probe contract. When package.json moves
// the pin past protocol#6, these become `type ProbeReport = OpenFlow.ProbeReport`
// and the compiler checks that nothing drifted. Until then, the doc comments
// live in the protocol; this file is only the shape.

export interface ProbeBand {
  hz: number;
  meanDb: number;
  floorDb: number;
  peakDb: number;
}

export interface ProbeReport {
  seconds: number;
  sampleRate: number;
  lufsIntegrated: number | null;
  lufsShortTermMax: number | null;
  loudnessRange: number | null;
  truePeakDb: number;
  samplePeakDb: number;
  rmsDb: number;
  overSamples: number;
  dcOffset: number;
  correlation: number;
  bands: ProbeBand[];
}

/** Every dB field is clamped here: below anything a 24-bit signal can hold. */
export const DB_FLOOR = -150;

/** 10·log10 of a power, clamped at DB_FLOOR. Never -Infinity, never NaN. */
export function powerDb(power: number): number {
  if (!(power > 0)) return DB_FLOOR;
  return Math.max(DB_FLOOR, 10 * Math.log10(power));
}

/** 20·log10 of an amplitude, clamped at DB_FLOOR. */
export function amplitudeDb(amplitude: number): number {
  return powerDb(amplitude * amplitude);
}
