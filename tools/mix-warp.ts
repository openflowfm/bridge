#!/usr/bin/env node
// Measure mix[flow]'s beat finding against the real library.
//
//   npm run warp:mix                      the library the app is pointed at
//   npm run warp:mix -- --library=/path   another one
//   npm run warp:mix -- --only=Sandstorm  one track, by a word of its title
//   npm run warp:mix -- --ab              every arm of the beat finding — ours,
//                                         and the library's stages swapped in
//                                         one at a time, see harness/arms.ts —
//                                         on the drums and on the whole,
//                                         scored side by side; --arms=ours,ellis
//                                         for some of them
//   npm run warp:mix -- --report          also write what the pipeline saw,
//                                         one JSON per track, for the harness
//                                         page under mix/harness to draw, and
//                                         score each track whose beats were
//                                         corrected by hand in the page, into
//                                         reports/errors/;
//                                         --report=/path to put it elsewhere
//   npm run warp:mix -- --file=/a.wav     bring a file into the harness's own
//   npm run warp:mix -- --youtube=URL     library, separate it, and run on that
//                                         library instead (--model= to choose)
//
// The synthetic fixtures under mix/src pass while real records fail, which is
// how two of five tracks came to be refused by a fit whose tests were green.
// This runs the whole pipeline — transients, tempo, the follower — on every
// track with a drums stem and prints what came out beside what is known to
// be true, from tools/mix-warp-truth.json. A truth entry is a tempo, and for
// a song that changes tempo, the sections it changes at.

import './cjs-dirname.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addFiles, read as readManifest, recordStems } from '../mix/electron/manifest.ts';
import { separate } from '../mix/electron/separate.ts';
import { addYoutube } from '../mix/electron/youtube.ts';
import { ARMS, INPUTS, run, SAYS, variantOf, type Arm, type Input } from '../mix/src/debug/arms.ts';
import { score, toMarkdown, type Score } from '../mix/harness/score.ts';
import type { IndexEntry, KnownTempo, Report, Truth } from '../mix/harness/types.ts';
import { peaksOf, readWav } from '../mix/src/audio.ts';
import { followOf, type Follow } from '../mix/src/follow.ts';
import type { Trace } from '../mix/src/trace.ts';
import { tempoOf, type Beats } from '../mix/src/warp.ts';

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

interface Track {
  id: string;
  title: string;
  stems: string | null;
  sources: string[];
}

const ONLY = arg('only');
/** Every arm on every input, against ours on the drums alone. */
const AB = process.argv.includes('--ab');
const ARMS_ASKED = arg('arms').split(',').filter(Boolean) as Arm[];
const FILE = arg('file');
const YOUTUBE = arg('youtube');
const INTAKE = Boolean(FILE || YOUTUBE);
const REPORT = process.argv.includes('--report') || INTAKE ? path.resolve(here, '..', 'mix', 'harness', 'reports') : arg('report');

/**
 * A file or a video brought into the harness's own library and separated
 * there, the way the app does it — the same manifest, the same worker, the
 * same Python environment the app built under Application Support — so the
 * real library is never written by a tool.
 */
async function intake(): Promise<string> {
  const root = path.join(REPORT, 'library');
  fs.mkdirSync(root, { recursive: true });
  const runtime = path.join(os.homedir(), 'Library', 'Application Support', '@openflow', 'mix', 'runtime');
  const added = FILE ? await addFiles(root, [path.resolve(FILE)]) : await addYoutube(root, YOUTUBE);
  if (!added.ids.length) throw new Error('nothing was added');
  const model = arg('model', 'htdemucs_ft');
  for (const id of added.ids) {
    const track = added.manifest.tracks.find((t) => t.id === id)!;
    console.log(`separating ${track.title} with ${model}`);
    let stage = '';
    const outcome = await separate(
      { root, runtime, trackId: id, file: track.file, model },
      {
        progress: (_id, progress) => {
          const now = `${progress.stage} ${Math.round(progress.done * 100)}%`;
          if (now !== stage) process.stdout.write(`\r  ${now.padEnd(40)}`);
          stage = now;
        },
      },
    );
    process.stdout.write('\n');
    if (!outcome.ok) throw new Error(outcome.says);
    await recordStems(root, id, { model: outcome.model, sources: outcome.sources, stems: outcome.stems, seconds: outcome.sidecar.seconds });
  }
  return root;
}

const LIBRARY = INTAKE ? await intake() : arg('library') || appLibrary();
const knownTempos = JSON.parse(fs.readFileSync(path.join(here, 'mix-warp-truth.json'), 'utf8')) as KnownTempo[];
const manifest = (await readManifest(LIBRARY)) as unknown as { tracks: Track[] };

/** The tempo the truth says the song runs at a moment. */
const trueTempo = (truth: KnownTempo, at: number): number => {
  let bpm = truth.bpm;
  for (const section of truth.sections ?? []) if (at >= section.from) bpm = section.bpm;
  return bpm;
};

/** The tempo the map runs at over eight bars around a moment. */
function mapTempo(beats: Beats, at: number): number {
  const sample = at * beats.rate;
  let i = 0;
  while (i + 1 < beats.samples.length && beats.samples[i + 1] < sample) i++;
  const lo = Math.max(0, i - 16);
  const hi = Math.min(beats.samples.length - 1, i + 16);
  return (60 * beats.rate * (hi - lo)) / (beats.samples[hi] - beats.samples[lo]);
}

/**
 * The stems beside the report, as hard links, so the harness page — served
 * from mix/ by the app's own dev server — can fetch them without the server
 * being told about a folder outside its root. A copy where a link is refused.
 */
function stemsBeside(track: Track, into: string): string[] {
  const dir = path.join(into, track.id);
  fs.mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  for (const source of track.sources) {
    const from = path.join(LIBRARY, track.stems!, `${source}.wav`);
    if (!fs.existsSync(from)) continue;
    const to = path.join(dir, `${source}.wav`);
    if (!fs.existsSync(to)) {
      try {
        fs.linkSync(from, to);
      } catch {
        fs.copyFileSync(from, to);
      }
    }
    out.push(`${track.id}/${source}.wav`);
  }
  return out;
}


/** The arms side by side, per track: the seed, and the score where the beats were corrected by hand. */
function abTable(rows: readonly Trial[]): string {
  const out: string[] = ['# The arms, side by side', ''];
  for (const arm of ARMS) out.push(`- **${arm}**: ${SAYS[arm]}`);
  out.push('', 'Score is against the beats corrected by hand in the harness page, over the region corrected. Seed ✓ is within a third of a per cent of the known tempo.', '');
  out.push('| track | input | arm | seed | F | on | shifted | missed | spurious | continuity | offset ms | shape | ms |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const t of rows) {
    const seed = t.bpm === null ? 'refused' : `${t.bpm}${t.seedOk === null ? '' : t.seedOk ? ' ✓' : ' ✗'}`;
    const s = t.score;
    const shape = s ? [s.octave ? `octave ${s.octave}` : '', s.offBeat ? 'off-beat' : '', s.phase ? `phase +${s.phase}` : ''].filter(Boolean).join(', ') || '—' : '—';
    const cell = (n: number | null | undefined, f = (x: number) => x.toFixed(2)): string => (n == null ? '—' : f(n));
    out.push(
      `| ${t.track.slice(0, 32)} | ${t.input} | ${t.arm} | ${seed} | ${cell(s?.fMeasure)} | ${cell(s?.counts.on, String)} | ${cell(s?.counts.shifted, String)} | ${cell(s?.counts.missed, String)} | ${cell(s?.counts.spurious, String)} | ${cell(s?.continuity)} | ${cell(s?.offsetMs.mean, (x) => x.toFixed(1))} | ${shape} | ${t.ms} |`,
    );
  }
  return out.join('\n');
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
console.log(`library: ${LIBRARY}\n`);
if (REPORT) fs.mkdirSync(REPORT, { recursive: true });
const index: IndexEntry[] = [];
console.log(pad('track', 34) + pad('truth', 10) + pad('seed', 12) + pad('beats', 7) + pad('on hit', 8) + pad('agree', 7) + pad('worst 8 bars', 16) + 'ms');
let failures = 0;

/** The stems of a track, read, or nothing where one is missing or unreadable. */
function stemsOf(track: Track): Record<string, { rate: number; channels: Float32Array[] }> | null {
  const out: Record<string, { rate: number; channels: Float32Array[] }> = {};
  for (const source of track.sources) {
    const file = path.join(LIBRARY, track.stems!, `${source}.wav`);
    if (!fs.existsSync(file)) return null;
    const bytes = fs.readFileSync(file);
    const wav = readWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    if (!wav) return null;
    out[source] = wav;
  }
  return out;
}

/** Every stem summed back into the whole, channel by channel. */
function summed(stems: Record<string, { rate: number; channels: Float32Array[] }>): Float32Array[] {
  const all = Object.values(stems);
  return all[0].channels.map((_, c) => {
    const out = new Float32Array(all[0].channels[c].length);
    for (const stem of all) {
      const channel = stem.channels[c] ?? stem.channels[0];
      for (let i = 0; i < out.length; i++) out[i] += channel[i];
    }
    return out;
  });
}

/** One row of the comparison: an arm on an input on a track, and how it scored. */
interface Trial {
  track: string;
  input: Input;
  arm: Arm;
  bpm: number | null;
  /** The seed within a third of a per cent of a known tempo, or null where none is known. */
  seedOk: boolean | null;
  score: Score | null;
  ms: number;
}
const trials: Trial[] = [];

for (const track of manifest.tracks) {
  if (!track.stems) continue;
  if (ONLY && !track.title.includes(ONLY)) continue;
  const truth = knownTempos.find((t) => track.title.includes(t.title));
  const stems = stemsOf(track);
  if (!stems?.drums) {
    console.log(pad(track.title.slice(0, 32), 34) + 'unreadable');
    continue;
  }
  const rate = stems.drums.rate;
  const heardBy: Record<Input, Float32Array[]> = { drums: stems.drums.channels, full: AB ? summed(stems) : [] };
  const corrected = REPORT ? path.join(REPORT, 'truth', `${track.id}.json`) : '';
  const judge: Truth | null = corrected && fs.existsSync(corrected) ? (JSON.parse(fs.readFileSync(corrected, 'utf8')) as Truth) : null;
  const variants: string[] = [];

  for (const input of INPUTS) {
    if (input !== 'drums' && !AB) continue;
    for (const arm of ARMS) {
      if (!AB && arm !== 'ours') continue;
      if (ARMS_ASKED.length && !ARMS_ASKED.includes(arm)) continue;
      const variant = variantOf(input, arm);
      const started = performance.now();
      const trace: Trace = { tempo: { frame: 0.004 }, follow: { frame: 0.004 } };
      const ran = run(arm, heardBy[input], rate, trace);
      const ms = Math.round(performance.now() - started);
      const seed = ran?.fit ?? null;
      const follow = ran?.follow ?? null;
      const beats = ran?.beats ?? null;
      const heard = ran?.heard ?? null;
      const seconds = heard?.seconds ?? stems.drums.channels[0].length / rate;
      let scored: Score | null = null;
      if (REPORT && heard) {
        const columns = Math.round((seconds / 60) * 1000);
        const buffer = { numberOfChannels: stems.drums.channels.length, length: stems.drums.channels[0].length, getChannelData: (c: number) => stems.drums.channels[c] };
        const { beats: _beats, ...rest } = follow ?? { beats: null };
        const report: Report = {
          track: { id: track.id, title: track.title, seconds, rate, stems: stemsBeside(track, REPORT) },
          heard,
          fit: seed,
          follow: follow ? (rest as Omit<Follow, 'beats'>) : null,
          beats,
          trace,
          peaks: { drums: peaksOf(buffer as unknown as AudioBuffer, columns), per: stems.drums.channels[0].length / columns },
          known: truth ?? null,
        };
        const name = variant ? `${track.id}.${variant}` : track.id;
        fs.writeFileSync(path.join(REPORT, `${name}.json`), JSON.stringify(report));
        if (variant) variants.push(variant);
        // Judged against the beats corrected by hand, where there are any. A
        // known tempo is not laid out as beats: a rip running 0.08% off its label
        // is 190 ms adrift after four minutes, and every beat would score missed.
        if (judge) {
          scored = score(report, judge);
          fs.mkdirSync(path.join(REPORT, 'errors'), { recursive: true });
          fs.writeFileSync(path.join(REPORT, 'errors', `${name}.md`), toMarkdown(report, judge, scored));
          fs.writeFileSync(path.join(REPORT, 'errors', `${name}.json`), JSON.stringify({ ...scored, rows: scored.rows.map(({ under, ...r }) => ({ ...r, under: under ? { band: under.band, strength: under.strength, level: under.level } : null })) }));
        }
      }
      const seedOk = truth && seed ? Math.abs(seed.bpm - truth.bpm) / truth.bpm < 0.003 || (truth.sections ?? []).some((s) => Math.abs(seed.bpm - s.bpm) / s.bpm < 0.003) : truth ? false : null;
      trials.push({ track: track.title, input, arm, bpm: seed?.bpm ?? null, seedOk, score: scored, ms });
      if (variant) continue;

      if (REPORT) index.push({ id: track.id, title: track.title, seconds, bpm: seed?.bpm ?? null, truth: judge !== null, arms: variants });
      const name = pad(track.title.slice(0, 32), 34);
      const known = truth ? (truth.sections ? `${truth.bpm}→${truth.sections.map((s) => s.bpm).join('→')}` : String(truth.bpm)) : '?';
      if (!seed || !follow) {
        console.log(name + pad(known, 10) + (seed ? pad(seed.bpm, 12) : pad('refused', 12)) + pad('none', 7) + ' '.repeat(31) + ms);
        failures++;
        continue;
      }
      // The worst eight-bar stretch against the truth, where there is one.
      let worst = 0;
      let worstAt = 0;
      if (truth) {
        for (let at = 8; at < seconds - 8; at += 4) {
          // Not across a change of tempo: eight bars straddling one read as
          // neither, and the change itself is asserted by the sections either side.
          if ((truth.sections ?? []).some((s) => Math.abs(s.from - at) < 10)) continue;
          const off = Math.abs(mapTempo(follow.beats, at) - trueTempo(truth, at)) / trueTempo(truth, at);
          if (off > worst) {
            worst = off;
            worstAt = at;
          }
        }
      }
      if (truth && (!seedOk || worst > 0.05)) failures++;
      console.log(
        name +
          pad(known, 10) +
          pad(`${seed.bpm}${seedOk === false ? ' ✗' : ''}`, 12) +
          pad(follow.beats.samples.length, 7) +
          pad(`${Math.round(follow.tracked * 100)}%`, 8) +
          pad(`${Math.round(follow.agreement * 100)}%`, 7) +
          pad(truth ? `${(worst * 100).toFixed(1)}% @ ${Math.round(worstAt)}s${worst > 0.05 ? ' ✗' : ''}` : `${tempoOf(follow.beats).toFixed(2)} mean`, 16) +
          ms,
      );
    }
  }
}
if (AB) {
  const table = abTable(trials);
  console.log(`\n${table}`);
  if (REPORT) fs.writeFileSync(path.join(REPORT, 'ab.md'), table);
}
if (REPORT) {
  // Merged into what is there, so a run over one library — or one file — does
  // not lose the entries a run over another wrote.
  const at = path.join(REPORT, 'index.json');
  const had: IndexEntry[] = fs.existsSync(at) ? (JSON.parse(fs.readFileSync(at, 'utf8')) as IndexEntry[]) : [];
  const merged = [...had.filter((h) => !index.some((i) => i.id === h.id)), ...index];
  fs.writeFileSync(at, JSON.stringify(merged, null, 2));
  console.log(`\nreports: ${REPORT}`);
}
console.log(failures ? `\n${failures} not right` : '\nall right');
process.exitCode = failures ? 1 : 0;
