#!/usr/bin/env node
// Measure mix[flow]'s beat finding against the real library.
//
//   npm run warp:mix                      the library the app is pointed at
//   npm run warp:mix -- --library=/path   another one
//   npm run warp:mix -- --only=Sandstorm  one track, by a word of its title
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
import { score, toMarkdown } from '../mix/harness/score.ts';
import type { IndexEntry, KnownTempo, Report, Truth } from '../mix/harness/types.ts';
import { peaksOf, readWav } from '../mix/src/audio.ts';
import { followOf, type Follow } from '../mix/src/follow.ts';
import { fitOf } from '../mix/src/tempo.ts';
import type { Trace } from '../mix/src/trace.ts';
import { heardIn } from '../mix/src/transients.ts';
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

const pad = (s: string | number, n: number) => String(s).padEnd(n);
console.log(`library: ${LIBRARY}\n`);
if (REPORT) fs.mkdirSync(REPORT, { recursive: true });
const index: IndexEntry[] = [];
console.log(pad('track', 34) + pad('truth', 10) + pad('seed', 12) + pad('beats', 7) + pad('on hit', 8) + pad('agree', 7) + pad('worst 8 bars', 16) + 'ms');
let failures = 0;
for (const track of manifest.tracks) {
  if (!track.stems) continue;
  if (ONLY && !track.title.includes(ONLY)) continue;
  const truth = knownTempos.find((t) => track.title.includes(t.title));
  const file = path.join(LIBRARY, track.stems, 'drums.wav');
  if (!fs.existsSync(file)) continue;
  const bytes = fs.readFileSync(file);
  const wav = readWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (!wav) {
    console.log(pad(track.title.slice(0, 32), 34) + 'unreadable');
    continue;
  }
  const started = performance.now();
  const trace: Trace = { tempo: { frame: 0.004 }, follow: { frame: 0.004 } };
  const heard = heardIn(wav.channels, wav.rate)!;
  const seed = fitOf(heard, trace.tempo);
  const follow = seed ? followOf(heard, seed, trace.follow) : null;
  const ms = Math.round(performance.now() - started);
  if (REPORT) {
    const columns = Math.round((heard.seconds / 60) * 1000);
    const buffer = { numberOfChannels: wav.channels.length, length: wav.channels[0].length, getChannelData: (c: number) => wav.channels[c] };
    const { beats, ...rest } = follow ?? { beats: null };
    const report: Report = {
      track: { id: track.id, title: track.title, seconds: heard.seconds, rate: wav.rate, stems: stemsBeside(track, REPORT) },
      heard,
      fit: seed,
      follow: follow ? (rest as Omit<Follow, 'beats'>) : null,
      beats,
      trace,
      peaks: { drums: peaksOf(buffer as unknown as AudioBuffer, columns), per: wav.channels[0].length / columns },
      known: truth ?? null,
    };
    fs.writeFileSync(path.join(REPORT, `${track.id}.json`), JSON.stringify(report));
    // Judged against the beats corrected by hand, where there are any. A
    // known tempo is not laid out as beats: a rip running 0.08% off its label
    // is 190 ms adrift after four minutes, and every beat would score missed.
    const corrected = path.join(REPORT, 'truth', `${track.id}.json`);
    const judge: Truth | null = fs.existsSync(corrected) ? (JSON.parse(fs.readFileSync(corrected, 'utf8')) as Truth) : null;
    if (judge) {
      const scored = score(report, judge);
      fs.mkdirSync(path.join(REPORT, 'errors'), { recursive: true });
      fs.writeFileSync(path.join(REPORT, 'errors', `${track.id}.md`), toMarkdown(report, judge, scored));
      fs.writeFileSync(path.join(REPORT, 'errors', `${track.id}.json`), JSON.stringify({ ...scored, rows: scored.rows.map(({ under, ...r }) => ({ ...r, under: under ? { band: under.band, strength: under.strength, level: under.level } : null })) }));
    }
    index.push({ id: track.id, title: track.title, seconds: heard.seconds, bpm: seed?.bpm ?? null, truth: judge !== null });
  }
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
    for (let at = 8; at < heard.seconds - 8; at += 4) {
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
  const seedOk = truth ? Math.abs(seed.bpm - truth.bpm) / truth.bpm < 0.003 || (truth.sections ?? []).some((s) => Math.abs(seed.bpm - s.bpm) / s.bpm < 0.003) : true;
  if (truth && (!seedOk || worst > 0.05)) failures++;
  console.log(
    name +
      pad(known, 10) +
      pad(`${seed.bpm}${seedOk ? '' : ' ✗'}`, 12) +
      pad(follow.beats.samples.length, 7) +
      pad(`${Math.round(follow.tracked * 100)}%`, 8) +
      pad(`${Math.round(follow.agreement * 100)}%`, 7) +
      pad(truth ? `${(worst * 100).toFixed(1)}% @ ${Math.round(worstAt)}s${worst > 0.05 ? ' ✗' : ''}` : `${tempoOf(follow.beats).toFixed(2)} mean`, 16) +
      ms,
  );
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
