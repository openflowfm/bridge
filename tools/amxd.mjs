#!/usr/bin/env node
// Pack / unpack Max for Live device files.
//
// .amxd is a chunked container around a plain .maxpat JSON patcher:
//
//   "ampf" u32le(4) <"aaaa"|"mmmm"|"iiii">   device type
//   "meta" u32le(4) 00 00 00 00
//   "ptch" u32le(n) <utf8 maxpat json> 0x00  (n includes the NUL)
//
// Verified against the templates Live 12 ships in
// App-Resources/Misc/Max Devices/.

import fs from 'node:fs';

export const DEVICE_TYPE = {
  audio: 'aaaa',
  midi: 'mmmm',
  instrument: 'iiii',
};

function chunk(id, payload) {
  const head = Buffer.alloc(8);
  head.write(id, 0, 4, 'ascii');
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

export function pack(patcher, type = 'audio') {
  const tag = DEVICE_TYPE[type];
  if (!tag) throw new Error(`unknown device type: ${type}`);
  const json =
    typeof patcher === 'string' ? patcher : JSON.stringify(patcher, null, '\t');
  const body = Buffer.concat([Buffer.from(json, 'utf8'), Buffer.from([0])]);
  return Buffer.concat([
    chunk('ampf', Buffer.from(tag, 'ascii')),
    chunk('meta', Buffer.alloc(4)),
    chunk('ptch', body),
  ]);
}

export function unpack(buf) {
  const chunks = {};
  let o = 0;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4);
    const len = buf.readUInt32LE(o + 4);
    chunks[id] = buf.subarray(o + 8, o + 8 + len);
    o += 8 + len;
  }
  if (!chunks.ptch) throw new Error('no ptch chunk — not an .amxd?');
  const type =
    Object.entries(DEVICE_TYPE).find(
      ([, tag]) => tag === chunks.ampf?.toString('ascii'),
    )?.[0] ?? 'unknown';
  const json = chunks.ptch.toString('utf8').replace(/\0+$/, '');
  return { type, patcher: JSON.parse(json) };
}

// CLI ------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, input, output, type] = process.argv.slice(2);
  if (cmd === 'pack') {
    const patcher = JSON.parse(fs.readFileSync(input, 'utf8'));
    fs.writeFileSync(output, pack(patcher, type || 'audio'));
    console.log(`packed ${input} -> ${output}`);
  } else if (cmd === 'unpack') {
    const { type: t, patcher } = unpack(fs.readFileSync(input));
    fs.writeFileSync(output, JSON.stringify(patcher, null, '\t'));
    console.log(`unpacked ${input} (${t}) -> ${output}`);
  } else {
    console.error('usage: amxd.mjs pack <in.maxpat> <out.amxd> [audio|midi|instrument]');
    console.error('       amxd.mjs unpack <in.amxd> <out.maxpat>');
    process.exit(1);
  }
}
