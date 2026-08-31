#!/usr/bin/env node
// Records a real session off the bridge, so tests can be written against the
// set you actually play rather than a fixture somebody imagined.
//
//   npm run dev:record -- <name> [seconds]
//
// Requires Live open with the device loaded. Writes two files under
// `set/test/corpus/<name>/`:
//
//   snapshot.json  one `snapshot` event — the set, and the model derived from it
//   stream.json    every broadcast that arrived while recording, in order
//
// **This never makes Live walk.** The snapshot is requested without `fresh`,
// which the bridge answers from the state it already holds (see `Request` in
// protocol/global.d.ts); it is free in exactly the way a client joining a
// running bridge is free. Only the Snapshot button walks the set — rule 5.
//
// It also does not `identify`. The roster's client kinds are the three real
// apps, and a recorder is not one of them; it shows up as an anonymous
// connection, which is what it is. Nothing is served differently for it.
//
// It *does* arm the viewport watches, because without them there is nothing to
// record: meters, play state, the mixer, the stop row and the device chains are
// all things a client asks for, and a recorder that only listens hears a set
// nobody is looking at. They are the recorder's own watches, released on the
// way out — none of this touches the two the device holds. Rule 5's question
// for a new watch is "whose is it": all seven here are a viewport's, held for
// as long as the recording and no longer.

import { DEFAULT_PORT, WS_PATH, type Event, type Request } from '@openflow/protocol/index.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/** One broadcast, and when it turned up relative to the start of the recording. */
interface Recorded {
  at: number;
  event: Event;
}

const root = resolve(import.meta.dirname, '..');

const name = process.argv[2] ?? 'session';
const seconds = Number(process.argv[3] ?? 60);

if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  console.error('usage: npm run dev:record -- <name> [seconds]');
  console.error('name is a directory under set/test/corpus, so: lowercase, digits, dashes');
  process.exit(1);
}
if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
  console.error('seconds must be between 1 and 600');
  process.exit(1);
}

// Meters run at frame rate and mixer state follows every fader move, so a
// minute of honest recording is tens of thousands of events — nearly all of
// them saying the same thing as the one before. A cap per type keeps enough
// consecutive frames to drive a store through real motion without committing a
// megabyte of decimals. The count that was dropped is reported, because "we
// kept 200 of 1,840" is a fact about the recording rather than a detail.
//
// Two caps, because a count is not a size: one `mixerState` carries every
// parameter of every track and runs 16KB, so 200 of them is a megabyte on their
// own and the meters, the clip status and the chains are rounding error beside
// them. Whichever cap a type reaches first is where it stops, and no one stream
// of chatter can crowd out the rest of the recording.
const CAP = 200;
const CAP_BYTES = 512 * 1024;

/** The six on/off viewport watches. `watchChains` is the seventh, and has a target. */
const WATCHES = [
  'watchPlay',
  'watchMeters',
  'watchStatus',
  'watchSends',
  'watchTransport',
  'watchScenes',
] as const satisfies readonly OpenFlow.RequestType[];

/** How many tracks' device runs to watch. Each one costs Live observers. */
const CHAINS = 4;

const url = process.env.OPENFLOW_WS || `ws://127.0.0.1:${DEFAULT_PORT}${WS_PATH}`;
const ws = new WebSocket(url);

await new Promise<void>((done, fail) => {
  ws.addEventListener('open', () => done(), { once: true });
  ws.addEventListener('error', () => fail(new Error(`could not connect to ${url}`)), {
    once: true,
  });
}).catch((err: Error) => {
  console.error(err.message);
  console.error('is Live open with the Session Bridge device loaded?');
  process.exit(1);
});

const startedAt = performance.now();
const stream: Recorded[] = [];
const kept = new Map<string, number>();
const bytes = new Map<string, number>();
const dropped = new Map<string, number>();
let snapshot: Event | null = null;

ws.addEventListener('message', (message) => {
  let event: Event;
  try {
    event = JSON.parse(String(message.data)) as Event;
  } catch {
    return;
  }

  // The snapshot is the reply we asked for and goes to its own file — it is
  // one event several megabytes wide, and nothing that reads the stream wants
  // to scroll past it.
  if (event.type === 'snapshot') {
    snapshot = event;
    return;
  }

  const seen = kept.get(event.type) ?? 0;
  const weight = bytes.get(event.type) ?? 0;
  if (seen >= CAP || weight >= CAP_BYTES) {
    dropped.set(event.type, (dropped.get(event.type) ?? 0) + 1);
    return;
  }
  kept.set(event.type, seen + 1);
  bytes.set(event.type, weight + String(message.data).length);
  stream.push({ at: Math.round(performance.now() - startedAt), event });
});

console.log(`recording from ${url}`);
ws.send(JSON.stringify({ id: 1, type: 'snapshot' } satisfies Request));

const waited = await new Promise<boolean>((done) => {
  const timer = setTimeout(() => done(false), 30_000);
  const poll = setInterval(() => {
    if (!snapshot) return;
    clearTimeout(timer);
    clearInterval(poll);
    done(true);
  }, 50);
});

if (!waited) {
  console.error('no snapshot in 30s — the bridge is connected but the LOM is not ready');
  ws.close();
  process.exit(1);
}

console.log(`snapshot: ${describe(snapshot!)}`);

for (const type of WATCHES) ws.send(JSON.stringify({ type, on: true } satisfies Request));
const subs = chainSubs(snapshot!);
ws.send(JSON.stringify({ type: 'watchChains', subs } satisfies Request));
console.log(`watching: ${WATCHES.join(', ')}, chains on ${subs.map((s) => s.t).join(', ')}`);
console.log();
console.log(`for the next ${seconds}s — ⌃C stops early:`);
console.log('  press play, and let a song run so meters and play state move');
console.log('  drag a volume fader down to -inf, and a send up');
console.log('  select a track with devices, and open one to see its parameters');

await new Promise<void>((done) => {
  const timer = setTimeout(done, seconds * 1000);
  process.on('SIGINT', () => {
    clearTimeout(timer);
    done();
  });
});

// Released explicitly rather than left to the socket closing. The bridge would
// drop them either way, but a recorder that hangs up mid-frame teaches nothing
// about what a well-behaved client does, and this file is read as an example.
for (const type of WATCHES) ws.send(JSON.stringify({ type, on: false } satisfies Request));
ws.send(JSON.stringify({ type: 'watchChains', subs: [] } satisfies Request));
await new Promise((done) => setTimeout(done, 100));
ws.close();

const dir = resolve(root, 'set/test/corpus', name);
mkdirSync(dir, { recursive: true });

const recordedAt = new Date().toISOString();
// The snapshot is indented and the stream is not, which is the difference
// between a file somebody reads and a file something replays: one set, laid out
// so a scene can be found in it, against several hundred frames of decimals.
const snapshotBytes = write('snapshot.json', { recordedAt, bridge: url, event: snapshot }, 2);
const streamBytes = write('stream.json', {
  recordedAt,
  bridge: url,
  seconds: Math.round((performance.now() - startedAt) / 1000),
  cap: CAP,
  capBytes: CAP_BYTES,
  dropped: Object.fromEntries([...dropped].sort()),
  events: stream,
});

console.log();
console.log(`wrote ${relative(root, dir)}/`);
console.log(`  snapshot.json  ${size(snapshotBytes)}`);
console.log(`  stream.json    ${size(streamBytes)}  ${stream.length} events`);
for (const [type, count] of [...kept].sort()) {
  const lost = dropped.get(type);
  console.log(`    ${type.padEnd(16)} ${count}${lost ? ` (+${lost} past the cap)` : ''}`);
}
console.log();
console.log('This is your set: song names, artists, tempos, keys and every clip name.');
console.log('Read it before committing it — this repository is public.');

function write(file: string, body: unknown, indent?: number): number {
  const json = `${JSON.stringify(body, null, indent)}\n`;
  writeFileSync(resolve(dir, file), json);
  return Buffer.byteLength(json);
}

function size(bytes: number): string {
  return bytes < 1024 * 1024 ?
      `${(bytes / 1024).toFixed(0)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Which device runs to watch, read off the set rather than asked for.
 *
 * Group tracks hold no devices of their own worth drawing, so the first few
 * ordinary tracks are the ones most likely to have a real chain on them — and a
 * real chain is the point: every device fixture in this repository is a guess at
 * what Live calls its parameters, and one recording of one running device
 * settles it. Device 0 is opened in each, which is what makes parameters arrive
 * rather than just the shell.
 */
function chainSubs(event: Event): OpenFlow.ChainWatch[] {
  if (event.type !== 'snapshot') return [];
  return event.data.tracks
    .filter((track) => !track.isGroup)
    .slice(0, CHAINS)
    .map((track) => ({ t: track.i, path: [], open: [0] }));
}

function describe(event: Event): string {
  if (event.type !== 'snapshot') return event.type;
  const { data, model, cached } = event;
  return (
    `${data.trackCount} tracks, ${data.sceneCount} scenes, ${data.clipCount} clips, ` +
    `${model.songs.length} song${model.songs.length === 1 ? '' : 's'}` +
    `${cached ? ' (held, no walk)' : ' (walked)'}`
  );
}
