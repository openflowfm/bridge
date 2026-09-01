#!/usr/bin/env node
// Sample ordinary video loops with the same measurements `npm run frames`
// applies to a graph rendered through the wall compositor.
//
//   npm run footage:frames -- --in=/tmp/loops --out=/tmp/loop-study
//   npm run footage:frames -- --in=/tmp/loops --samples=8 --size=320x180

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  cyclicMotion,
  metricsOf,
  type FrameMetrics,
} from '../visuals/frameMetrics.ts';

const arg = (name: string, fallback = ''): string => {
  const found = process.argv.find((each) => each.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const INPUT = path.resolve(arg('in'));
const OUTPUT = path.resolve(arg('out', path.join(INPUT, 'frame-study')));
const SAMPLES = Number(arg('samples', '8'));
const [WIDTH, HEIGHT] = arg('size', '320x180').split('x').map(Number);
const VIDEO = /\.(?:m4v|mov|mp4|webm)$/i;

if (!arg('in')) throw new Error('footage:frames needs --in=/directory/of/loops');
if (!Number.isInteger(SAMPLES) || SAMPLES < 2 || SAMPLES > 32) {
  throw new Error('--samples must be an integer from 2 through 32');
}
if (![WIDTH, HEIGHT].every((value) => Number.isInteger(value) && value > 0 && value <= 4096)) {
  throw new Error('--size must be WIDTHxHEIGHT, with each edge from 1 through 4096');
}

const files = fs
  .readdirSync(INPUT, { withFileTypes: true })
  .filter((entry) => entry.isFile() && VIDEO.test(entry.name))
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
if (files.length === 0) throw new Error(`no supported video loops in ${INPUT}`);

fs.mkdirSync(path.join(OUTPUT, 'strips'), { recursive: true });

const run = (command: string, args: string[], maxBuffer = 1024 * 1024): Buffer => {
  const result = spawnSync(command, args, { encoding: null, maxBuffer });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command}: ${String(result.stderr).trim() || `exit ${result.status}`}`);
  }
  return result.stdout;
};

const durationOf = (file: string): number => {
  const said = run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    file,
  ]).toString('utf8').trim();
  const duration = Number(said);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`${file}: no finite duration`);
  return duration;
};

interface SampledLoop {
  name: string;
  file: string;
  strip: string;
  duration: number;
  motion: number;
  frames: Array<FrameMetrics & { phase: number }>;
  mean: FrameMetrics;
}

const metricNames = [
  'lum', 'black', 'dark', 'coverage', 'white', 'peak', 'chroma', 'edge',
  'centreX', 'centreY', 'spread', 'mirrorX', 'mirrorY', 'terrace',
] as const satisfies readonly (keyof FrameMetrics)[];

const meanOf = (frames: readonly FrameMetrics[]): FrameMetrics =>
  Object.fromEntries(
    metricNames.map((name) => [
      name,
      frames.reduce((sum, frame) => sum + frame[name], 0) / frames.length,
    ]),
  ) as unknown as FrameMetrics;

const safeName = (name: string): string => name.replace(/[^\w.-]+/g, '_');
const loops: SampledLoop[] = [];
const bytesPerFrame = WIDTH * HEIGHT * 4;

for (const name of files) {
  const file = path.join(INPUT, name);
  const duration = durationOf(file);
  const rate = `${SAMPLES}/${duration}`;
  const raw = run(
    'ffmpeg',
    [
      '-v', 'error', '-i', file,
      '-vf', `fps=${rate},scale=${WIDTH}:${HEIGHT}:flags=lanczos,format=rgba`,
      '-frames:v', String(SAMPLES), '-f', 'rawvideo', '-',
    ],
    bytesPerFrame * SAMPLES + 1024 * 1024,
  );
  if (raw.length !== bytesPerFrame * SAMPLES) {
    throw new Error(`${name}: expected ${SAMPLES} frames, received ${raw.length / bytesPerFrame}`);
  }

  const frames = Array.from({ length: SAMPLES }, (_, index) =>
    new Uint8Array(raw.buffer, raw.byteOffset + index * bytesPerFrame, bytesPerFrame),
  );
  const measured = frames.map((pixels, index) => ({
    phase: index / SAMPLES,
    ...metricsOf(pixels, WIDTH, HEIGHT),
  }));
  const stem = safeName(path.parse(name).name);
  const strip = `strips/${stem}.png`;
  run('ffmpeg', [
    '-v', 'error', '-i', file,
    '-vf', `fps=${rate},scale=${WIDTH}:${HEIGHT}:flags=lanczos,tile=${SAMPLES}x1`,
    '-frames:v', '1', path.join(OUTPUT, strip),
  ]);
  loops.push({
    name: path.parse(name).name,
    file: name,
    strip,
    duration,
    motion: cyclicMotion(frames),
    frames: measured,
    mean: meanOf(measured),
  });
  process.stdout.write(`\rfootage:frames ${loops.length}/${files.length}`);
}
process.stdout.write('\n');

const report = {
  width: WIDTH,
  height: HEIGHT,
  samples: SAMPLES,
  source: INPUT,
  loops,
};
fs.writeFileSync(path.join(OUTPUT, 'stats.json'), JSON.stringify(report, null, 2));

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');
const cards = loops.map((loop) => `
  <article>
    <h2>${escapeHtml(loop.name)}</h2>
    <img src="${escapeHtml(loop.strip)}" width="${WIDTH * SAMPLES}" height="${HEIGHT}" alt="Equal-phase frames from ${escapeHtml(loop.name)}">
    <p>${loop.duration.toFixed(2)}s · motion ${(loop.motion * 100).toFixed(2)}% · luma ${loop.mean.lum.toFixed(1)} · dark ${(loop.mean.dark * 100).toFixed(1)}% · coverage ${(loop.mean.coverage * 100).toFixed(1)}% · edge ${loop.mean.edge.toFixed(1)} · symmetry ${Math.max(loop.mean.mirrorX, loop.mean.mirrorY).toFixed(3)}</p>
  </article>`).join('');
fs.writeFileSync(path.join(OUTPUT, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Footage frame study</title>
<style>
  html { color-scheme: dark; background: #08090b; color: #ececed; font: 13px ui-monospace, monospace; }
  body { margin: 24px; } article { margin: 0 0 28px; } h2 { margin: 0 0 6px; font-size: 15px; }
  img { display: block; width: min(100%, ${WIDTH * SAMPLES}px); height: auto; background: #000; }
  p { margin: 6px 0 0; color: #aeb3bb; }
</style></head><body><h1>Footage frame study</h1>${cards}</body></html>`);

console.log(`${loops.length} loops × ${SAMPLES} phases at ${WIDTH}x${HEIGHT} in ${OUTPUT}`);
