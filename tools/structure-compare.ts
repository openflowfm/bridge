#!/usr/bin/env node
// Compare one graph flow to one footage loop by contour and topology rather
// than by exposure, palette, or the amount of black in the frame.
//
//   node tools/structure-compare.ts --reference=/tmp/Xenon_74.mp4 \
//     --graph=/tmp/graph-study --flow=weave

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { structuralDifference, structureOf } from '../visuals/structuralMetrics.ts';

const arg = (name: string, fallback = ''): string => {
  const found = process.argv.find((each) => each.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const reference = path.resolve(arg('reference'));
const graph = path.resolve(arg('graph'));
const flow = arg('flow');
const samples = Number(arg('samples', '8'));
const [width, height] = arg('size', '320x180').split('x').map(Number);
if (!arg('reference') || !arg('graph') || !flow) {
  throw new Error('needs --reference=/loop.mp4 --graph=/frames-output --flow=id');
}

const run = (command: string, args: string[], maxBuffer: number): Buffer => {
  const result = spawnSync(command, args, { encoding: null, maxBuffer });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr).trim() || `${command} failed`);
  return result.stdout;
};
const duration = Number(run('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', reference,
], 1024 * 1024).toString('utf8'));
const frameBytes = width * height * 4;
const rawReference = run('ffmpeg', [
  '-v', 'error', '-i', reference,
  '-vf', `fps=${samples}/${duration},scale=${width}:${height}:flags=lanczos,format=rgba`,
  '-frames:v', String(samples), '-f', 'rawvideo', '-',
], frameBytes * samples + 1024 * 1024);
const references = Array.from({ length: samples }, (_, index) =>
  structureOf(new Uint8Array(rawReference.buffer, rawReference.byteOffset + index * frameBytes, frameBytes), width, height));

const report = JSON.parse(fs.readFileSync(path.join(graph, 'stats.json'), 'utf8'));
const beats = report.stats.filter((entry: { flow: string }) => entry.flow === flow)
  .map((entry: { beat: number }) => entry.beat);
if (beats.length !== samples) throw new Error(`${flow}: expected ${samples} graph frames, found ${beats.length}`);
const graphs = beats.map((beat: number) => {
  const file = path.join(graph, `${flow}@${beat}.png`);
  const raw = run('ffmpeg', [
    '-v', 'error', '-i', file, '-vf', `scale=${width}:${height}:flags=lanczos,format=rgba`,
    '-frames:v', '1', '-f', 'rawvideo', '-',
  ], frameBytes + 1024 * 1024);
  return structureOf(new Uint8Array(raw.buffer, raw.byteOffset, frameBytes), width, height);
});

let best: {
  shift: number;
  direction: number;
  contour: number;
  iou: number;
  holes: number;
  endpoints: number;
  junctions: number;
} | null = null;
for (const direction of [1, -1]) {
  for (let shift = 0; shift < samples; shift++) {
    let contour = 0;
    let iou = 0;
    let holes = 0;
    let endpoints = 0;
    let junctions = 0;
    for (let index = 0; index < samples; index++) {
      const target = (shift + direction * index + samples * 2) % samples;
      const compared = structuralDifference(graphs[index], references[target], width, height);
      contour += compared.contourDistance;
      iou += compared.silhouetteIoU;
      holes += Math.abs(compared.leftHoles - compared.rightHoles);
      endpoints += Math.abs(compared.leftEndpoints - compared.rightEndpoints);
      junctions += Math.abs(compared.leftJunctions - compared.rightJunctions);
    }
    const candidate = {
      shift,
      direction,
      contour: contour / samples,
      iou: iou / samples,
      holes: holes / samples,
      endpoints: endpoints / samples,
      junctions: junctions / samples,
    };
    if (!best || candidate.contour < best.contour) best = candidate;
  }
}

console.log(`${flow} against ${path.basename(reference)}`);
console.log(`phase shift ${best!.shift}/${samples}, direction ${best!.direction > 0 ? 'forward' : 'reverse'}`);
console.log(`contour distance ${(best!.contour * 100).toFixed(2)}% of frame diagonal`);
console.log(`silhouette IoU ${(best!.iou * 100).toFixed(1)}%`);
console.log(`mean enclosed-region mismatch ${best!.holes.toFixed(2)}`);
console.log(`mean curve-endpoint mismatch ${best!.endpoints.toFixed(2)}`);
console.log(`mean junction mismatch ${best!.junctions.toFixed(2)}`);
