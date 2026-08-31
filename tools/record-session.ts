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
const CAP = 200;

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
  if (seen >= CAP) {
    dropped.set(event.type, (dropped.get(event.type) ?? 0) + 1);
    return;
  }
  kept.set(event.type, seen + 1);
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
console.log(`now play, click, drag and open a device chain for ${seconds}s — ⌃C stops early`);

await new Promise<void>((done) => {
  const timer = setTimeout(done, seconds * 1000);
  process.on('SIGINT', () => {
    clearTimeout(timer);
    done();
  });
});

ws.close();

const dir = resolve(root, 'set/test/corpus', name);
mkdirSync(dir, { recursive: true });

const recordedAt = new Date().toISOString();
const snapshotBytes = write('snapshot.json', { recordedAt, bridge: url, event: snapshot });
const streamBytes = write('stream.json', {
  recordedAt,
  bridge: url,
  seconds: Math.round((performance.now() - startedAt) / 1000),
  cap: CAP,
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

function write(file: string, body: unknown): number {
  const json = `${JSON.stringify(body, null, 2)}\n`;
  writeFileSync(resolve(dir, file), json);
  return Buffer.byteLength(json);
}

function size(bytes: number): string {
  return bytes < 1024 * 1024 ?
      `${(bytes / 1024).toFixed(0)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
