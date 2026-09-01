#!/usr/bin/env node
// Compare one graph flow to one footage loop by contour and topology rather
// than by exposure, palette, or the amount of black in the frame.
//
//   node tools/structure-compare.ts --reference=/tmp/Xenon_74.mp4 \
//     --graph=/tmp/graph-study --flow=weave --cycles=2

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cyclicMotion } from '../visuals/frameMetrics.ts';
import {
  materialStructureDifference,
  materialStructureOf,
  structuralDifference,
  structureOf,
} from '../visuals/structuralMetrics.ts';

const arg = (name: string, fallback = ''): string => {
  const found = process.argv.find((each) => each.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const reference = path.resolve(arg('reference'));
const graph = path.resolve(arg('graph'));
const flow = arg('flow');
const samples = Number(arg('samples', '8'));
// Preview encodes often repeat a seamless loop more than once. Compare one
// fundamental period rather than making one graph cycle chase duplicate target
// poses across the container duration.
const cycles = Number(arg('cycles', '1'));
const [width, height] = arg('size', '320x180').split('x').map(Number);
if (!arg('reference') || !arg('graph') || !flow) {
  throw new Error('needs --reference=/loop.mp4 --graph=/frames-output --flow=id');
}
if (!Number.isInteger(cycles) || cycles < 1) throw new Error('--cycles must be a positive integer');

const run = (command: string, args: string[], maxBuffer: number): Buffer => {
  const result = spawnSync(command, args, { encoding: null, maxBuffer });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr).trim() || `${command} failed`);
  return result.stdout;
};
const duration = Number(run('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', reference,
], 1024 * 1024).toString('utf8'));
const period = duration / cycles;
const frameBytes = width * height * 4;
const rawReference = run('ffmpeg', [
  '-v', 'error', '-i', reference, '-t', String(period),
  '-vf', `fps=${samples}/${period},scale=${width}:${height}:flags=lanczos,format=rgba`,
  '-frames:v', String(samples), '-f', 'rawvideo', '-',
], frameBytes * samples + 1024 * 1024);
const referencePixels = Array.from({ length: samples }, (_, index) =>
  new Uint8Array(rawReference.buffer, rawReference.byteOffset + index * frameBytes, frameBytes));
const references = referencePixels.map((pixels) => structureOf(pixels, width, height));
const referenceMaterials = referencePixels.map((pixels) => materialStructureOf(pixels, width, height));

const report = JSON.parse(fs.readFileSync(path.join(graph, 'stats.json'), 'utf8'));
const beats: number[] = report.stats.filter((entry: { flow: string }) => entry.flow === flow)
  .map((entry: { beat: number }) => entry.beat);
if (beats.length !== samples) throw new Error(`${flow}: expected ${samples} graph frames, found ${beats.length}`);
const graphPixels: Uint8Array[] = beats.map((beat: number) => {
  const file = path.join(graph, `${flow}@${beat}.png`);
  const raw = run('ffmpeg', [
    '-v', 'error', '-i', file, '-vf', `scale=${width}:${height}:flags=lanczos,format=rgba`,
    '-frames:v', '1', '-f', 'rawvideo', '-',
  ], frameBytes + 1024 * 1024);
  return new Uint8Array(raw.buffer, raw.byteOffset, frameBytes);
});
const graphs = graphPixels.map((pixels) => structureOf(pixels, width, height));
const graphMaterials = graphPixels.map((pixels) => materialStructureOf(pixels, width, height));

let best: {
  shift: number;
  direction: number;
  contour: number;
  iou: number;
  holes: number;
  endpoints: number;
  junctions: number;
  material: number;
} | null = null;
for (const direction of [1, -1]) {
  for (let shift = 0; shift < samples; shift++) {
    let contour = 0;
    let iou = 0;
    let holes = 0;
    let endpoints = 0;
    let junctions = 0;
    let material = 0;
    for (let index = 0; index < samples; index++) {
      const target = (shift + direction * index + samples * 2) % samples;
      const compared = structuralDifference(graphs[index], references[target], width, height);
      contour += compared.contourDistance;
      iou += compared.silhouetteIoU;
      holes += Math.abs(compared.leftHoles - compared.rightHoles);
      endpoints += Math.abs(compared.leftEndpoints - compared.rightEndpoints);
      junctions += Math.abs(compared.leftJunctions - compared.rightJunctions);
      material += materialStructureDifference(graphMaterials[index], referenceMaterials[target]);
    }
    const candidate = {
      shift,
      direction,
      contour: contour / samples,
      iou: iou / samples,
      holes: holes / samples,
      endpoints: endpoints / samples,
      junctions: junctions / samples,
      material: material / samples,
    };
    if (!best || candidate.contour < best.contour) best = candidate;
  }
}

console.log(`${flow} against ${path.basename(reference)}`);
if (cycles > 1) console.log(`fundamental period ${(period).toFixed(3)}s (${cycles} cycles in container)`);
console.log(`phase shift ${best!.shift}/${samples}, direction ${best!.direction > 0 ? 'forward' : 'reverse'}`);
console.log(`contour distance ${(best!.contour * 100).toFixed(2)}% of frame diagonal`);
console.log(`silhouette IoU ${(best!.iou * 100).toFixed(1)}%`);
console.log(`mean enclosed-region mismatch ${best!.holes.toFixed(2)}`);
console.log(`mean curve-endpoint mismatch ${best!.endpoints.toFixed(2)}`);
console.log(`mean junction mismatch ${best!.junctions.toFixed(2)}`);
console.log(`spatial material/colour difference ${(best!.material * 100).toFixed(1)}%`);

const persistence = (frames: ReturnType<typeof structureOf>[]): number => {
  if (frames.length < 2) return 1;
  let sum = 0;
  for (let index = 0; index < frames.length; index++) {
    sum += structuralDifference(frames[index], frames[(index + 1) % frames.length], width, height).silhouetteIoU;
  }
  return sum / frames.length;
};
const graphMotion = cyclicMotion(graphPixels);
const referenceMotion = cyclicMotion(referencePixels);
const graphPersistence = persistence(graphs);
const referencePersistence = persistence(references);
console.log(`cyclic RGB motion graph ${(graphMotion * 100).toFixed(2)}%, reference ${(referenceMotion * 100).toFixed(2)}%`);
console.log(`topology persistence graph ${(graphPersistence * 100).toFixed(1)}%, reference ${(referencePersistence * 100).toFixed(1)}%`);

if (process.argv.includes('--assert')) {
  const limit = (name: string, fallback: number): number => Number(arg(name, String(fallback)));
  const checks: [boolean, string][] = [
    [best!.contour <= limit('max-contour', 0.025), 'contour'],
    [best!.iou >= limit('min-iou', 0.1), 'silhouette IoU'],
    [best!.holes <= limit('max-holes', 12), 'enclosed regions'],
    [best!.endpoints <= limit('max-endpoints', 35), 'curve endpoints'],
    [best!.junctions <= limit('max-junctions', 35), 'junction/occlusion structure'],
    [best!.material <= limit('max-material', 0.3), 'material/colour structure'],
    [graphMotion >= limit('min-motion', 0.01), 'cyclic motion floor'],
    [Math.abs(graphMotion - referenceMotion) <= limit('max-motion-gap', 0.18), 'cyclic motion comparison'],
    // More stable than compressed reference highlights is not a failure. This
    // gate asks the semantic question: do the same projected rails persist
    // across the loop instead of being replaced by unrelated silhouettes?
    [graphPersistence >= limit('min-persistence', 0.3), 'topology persistence'],
  ];
  const failed = checks.filter(([passed]) => !passed).map(([, name]) => name);
  if (failed.length) throw new Error(`structural comparison failed: ${failed.join(', ')}`);
  console.log('structural comparison PASS');
}
