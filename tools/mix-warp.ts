#!/usr/bin/env node
// Measure mix[flow]'s beat finding against the real library.
//
//   npm run warp:mix                      the library the app is pointed at
//   npm run warp:mix -- --library=/path   another one
//   npm run warp:mix -- --only=Sandstorm  one track, by a word of its title
//
// The synthetic fixtures under mix/src pass while real records fail, which is
// how two of five tracks came to be refused by a fit whose tests were green.
// This runs the whole pipeline — transients, tempo, the follower — on every
// track with a drums stem and prints what came out beside what is known to
// be true, from tools/mix-warp-truth.json. A truth entry is a tempo, and for
// a song that changes tempo, the sections it changes at.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav } from '../mix/src/audio.ts';
import { followOf } from '../mix/src/follow.ts';
import { fitOf } from '../mix/src/tempo.ts';
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

interface Truth {
  /** A word of the title. */
  title: string;
  /** The tempo, or the tempo the song opens at. */
  bpm: number;
  /** Where the tempo changes: from this second on, this tempo. */
  sections?: { from: number; bpm: number }[];
  note?: string;
}

interface Track {
  title: string;
  stems: string | null;
}

const LIBRARY = arg('library') || appLibrary();
const ONLY = arg('only');
const truths = JSON.parse(fs.readFileSync(path.join(here, 'mix-warp-truth.json'), 'utf8')) as Truth[];
const manifest = JSON.parse(fs.readFileSync(path.join(LIBRARY, 'library.json'), 'utf8')) as { tracks: Track[] };

/** The tempo the truth says the song runs at a moment. */
const trueTempo = (truth: Truth, at: number): number => {
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

const pad = (s: string | number, n: number) => String(s).padEnd(n);
console.log(`library: ${LIBRARY}\n`);
console.log(pad('track', 34) + pad('truth', 10) + pad('seed', 12) + pad('beats', 7) + pad('on hit', 8) + pad('agree', 7) + pad('worst 8 bars', 16) + 'ms');
let failures = 0;
for (const track of manifest.tracks) {
  if (!track.stems) continue;
  if (ONLY && !track.title.includes(ONLY)) continue;
  const truth = truths.find((t) => track.title.includes(t.title));
  const file = path.join(LIBRARY, track.stems, 'drums.wav');
  if (!fs.existsSync(file)) continue;
  const bytes = fs.readFileSync(file);
  const wav = readWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (!wav) {
    console.log(pad(track.title.slice(0, 32), 34) + 'unreadable');
    continue;
  }
  const started = performance.now();
  const heard = heardIn(wav.channels, wav.rate)!;
  const seed = fitOf(heard);
  const follow = seed ? followOf(heard, seed) : null;
  const ms = Math.round(performance.now() - started);
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
console.log(failures ? `\n${failures} not right` : '\nall right');
process.exitCode = failures ? 1 : 0;
