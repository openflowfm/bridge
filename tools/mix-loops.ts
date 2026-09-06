// The loop report: does a file pinned every so many bars loop where Live will
// loop it?
//
// For every track in the app's library with stems and a grid, the drums stem
// is laid straight exactly as Export lays it — pinned every 8 bars from 1.1.1,
// and again every 4 and every 16 — and then *heard again*: the transient
// detector runs over the output, and each lattice line is measured against
// the kick nearest it. A file that loops cleanly under global quantization
// has a kick on every line it can be launched from; the number here is how
// far off that kick is, in milliseconds, at the median and at the worst.
//
// No threshold is asserted. The detector's own scatter is a few milliseconds
// on a clean record; a line tens of milliseconds out is a grid that is wrong
// there, not a pin — that track goes to the beat finding as a bar number.
//
//   npm run loops:mix                       every track, into mix/harness/reports/loops.md
//   npm run loops:mix -- --only=Sandstorm   one track, by a piece of its title
//   npm run loops:mix -- --library=/path    a library other than the app's
//
// Lines with no kick within half a beat — a breakdown, a silence, the padded
// end — are counted and left out of the numbers, so a drop that stops the kick
// does not read as a grid that is wrong. *On* is how many lines had a kick
// within ten milliseconds, the tolerance `loosest` measures to.
import './cjs-dirname.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAnalysis } from '../mix/electron/analysis.ts';
import { read as readManifest } from '../mix/electron/manifest.ts';
import { readWav } from '../mix/src/audio.ts';
import { straightened } from '../mix/src/straighten.ts';
import { heardIn } from '../mix/src/transients.ts';
import { BEATS_PER_BAR, type Beats } from '../mix/src/warp.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

const arg = (name: string, fallback = ''): string => {
  const found = process.argv.find((each) => each.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

/** The library the app is pointed at, from its own settings. */
function appLibrary(): string {
  const settings = path.join(os.homedir(), '.openflow', 'mix', 'electron', 'settings.json');
  const read = JSON.parse(fs.readFileSync(settings, 'utf8')) as { library?: string };
  if (!read.library) throw new Error(`no library in ${settings}; pass --library=`);
  return read.library;
}

/** The loop lengths the dialog offers. Sections have no lattice to measure. */
const LOOP_LENGTHS = [4, 8, 16] as const;

const ONLY = arg('only').toLowerCase();
const LIBRARY = arg('library') || appLibrary();
const REPORT = path.resolve(here, '..', 'mix', 'harness', 'reports', 'loops.md');

interface Track {
  id: string;
  title: string;
  stems: string | null;
  sources: string[];
}

/** One loop length on one track: how the lattice lines sat against the kicks. */
interface Row {
  every: number;
  lines: number;
  /** Lines with no kick within half a beat, left out of the numbers. */
  silent: number;
  /** Lines with a kick within ten milliseconds. */
  on: number;
  median: number;
  /** Nine lines in ten are at least this close. */
  p90: number;
  worst: number;
  /** The bar the worst line is on, from 1. */
  worstBar: number;
}

const ms = (n: number): string => n.toFixed(1);

/** The nearest of a sorted list to a value. */
function nearest(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  const after = sorted[lo];
  const before = sorted[lo - 1];
  return before !== undefined && Math.abs(before - value) < Math.abs(after - value) ? before : after;
}

function measure(channels: readonly Float32Array[], rate: number, beats: Beats, bpm: number, offset: number, to: number, every: number): Row {
  const laid = straightened(channels, rate, { bpm, offset, to, beats, every: every as 4 | 8 | 16, cuts: [] });
  const heard = heardIn(laid.channels, laid.rate);
  const kicks = (heard?.transients ?? []).filter((hit) => hit.band === 'low').map((hit) => hit.sample);
  const spacing = (60 * laid.rate) / to;
  const bar = spacing * BEATS_PER_BAR;
  const distances: { at: number; bar: number }[] = [];
  let lines = 0;
  let silent = 0;
  for (let n = 0; n * every < laid.bars; n++) {
    const line = n * every * bar;
    lines++;
    if (kicks.length === 0) {
      silent++;
      continue;
    }
    const off = Math.abs(nearest(kicks, line) - line);
    if (off > spacing / 2) {
      silent++;
      continue;
    }
    distances.push({ at: (off / laid.rate) * 1000, bar: n * every + 1 });
  }
  const sorted = distances.map((d) => d.at).sort((a, b) => a - b);
  const median = sorted.length ? sorted[sorted.length >> 1] : 0;
  const p90 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] : 0;
  const on = sorted.filter((at) => at <= 10).length;
  const worstOf = distances.reduce((a, b) => (b.at > a.at ? b : a), { at: 0, bar: 1 });
  return { every, lines, silent, on, median, p90, worst: worstOf.at, worstBar: worstOf.bar };
}

const manifest = (await readManifest(LIBRARY)) as unknown as { tracks: Track[] };
const out: string[] = [
  '# Where the kicks landed',
  '',
  'The drums stem of every track, laid straight as Export lays it — pinned at every line a',
  'loop of this length starts on, from 1.1.1 — and heard again. Each line is measured against',
  'the kick nearest it in the *output*. Lines with no kick within half a beat are counted as',
  'silent and left out of the numbers. *On* is lines with a kick within ten milliseconds, the',
  'tolerance the measured default is chosen to. No threshold is asserted: the number is the point.',
  '',
  `Library: \`${LIBRARY}\`. ${new Date().toISOString().slice(0, 16).replace('T', ' ')}.`,
  '',
  '| track | laid at | loops of | lines | silent | on | median ms | p90 ms | worst ms | worst at bar |',
  '|---|---|---|---|---|---|---|---|---|---|',
];
const skipped: string[] = [];
for (const track of manifest.tracks) {
  if (ONLY && !track.title.toLowerCase().includes(ONLY)) continue;
  const analysis = await readAnalysis(LIBRARY, track.id);
  const grid = analysis?.grid;
  if (!track.stems || !track.sources.includes('drums')) {
    skipped.push(`${track.title}: no drums stem`);
    continue;
  }
  if (!grid?.beats) {
    skipped.push(`${track.title}: no grid`);
    continue;
  }
  const file = path.join(LIBRARY, track.stems, 'drums.wav');
  const bytes = fs.readFileSync(file);
  const wav = readWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (!wav) {
    skipped.push(`${track.title}: ${file} is not a wav this reads`);
    continue;
  }
  const to = Math.round(grid.bpm);
  process.stdout.write(`${track.title} at ${to}`);
  for (const every of LOOP_LENGTHS) {
    const row = measure(wav.channels, wav.rate, grid.beats, grid.bpm, grid.offset, to, every);
    process.stdout.write(` · ${every}: ${row.on}/${row.lines - row.silent} on, ${ms(row.median)} / ${ms(row.p90)} / ${ms(row.worst)}`);
    out.push(
      `| ${track.title} | ${to} | ${every} | ${row.lines} | ${row.silent} | ${row.on} | ${ms(row.median)} | ${ms(row.p90)} | ${ms(row.worst)} | ${row.worstBar} |`,
    );
  }
  process.stdout.write('\n');
}
if (skipped.length) out.push('', 'Not measured:', '', ...skipped.map((line) => `- ${line}`));
out.push('');
fs.writeFileSync(REPORT, out.join('\n'));
console.log(`→ ${REPORT}`);
