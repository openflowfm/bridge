// The probe's [v8] entry. esbuild bundles this into probe.js as an IIFE whose
// result is the global `__probe`; tools/build-probe.ts then appends a plain
// script tail that hands this function Max's own globals and declares the
// top-level handlers Max looks for. Keeping every Max name in that tail is what
// lets everything here be ordinary, testable modules.

import { Accumulator } from './accumulator.ts';
import { coefficients } from './coefficients.ts';
import { createProbe, type Host, type Probe } from './device.ts';

export function start(host: Host): Probe {
  return createProbe(host, {
    newAccumulator: (sampleRate) => new Accumulator(sampleRate),
    coefficients,
  });
}
