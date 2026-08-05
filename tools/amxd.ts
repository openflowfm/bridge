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
//
// A *frozen* device replaces the ptch payload with an "mx@c" archive holding the
// patcher plus every file it depends on — see parseFrozen below. Freezing is done
// by Live, not by us, so this file reads that format and never writes it.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export type DeviceType = 'audio' | 'midi' | 'instrument';

export const DEVICE_TYPE: Record<DeviceType, string> = {
  audio: 'aaaa',
  midi: 'mmmm',
  instrument: 'iiii',
};

function chunk(id: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(id, 0, 4, 'ascii');
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

export function pack(patcher: unknown, type: DeviceType = 'audio'): Buffer {
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

/** One file Live inlined into a frozen device. */
export interface FrozenFile {
  /** Live's own 4-char kind: `JSON` (patchers), `TEXT` (js, txt), `svg`, … */
  kind: string;
  name: string;
  data: Buffer;
}

const FROZEN_MAGIC = 'mx@c';

/**
 * Read the "mx@c" archive that a frozen device carries in place of raw patcher
 * JSON. Decoded by dissecting devices in the User Library; not documented by
 * Ableton, and not verified as widely as the outer container is.
 *
 *   "mx@c" u32be(16)      header size — where the data region starts
 *          u64be(n)       length of the data region
 *          <data>         patcher JSON first, then every embedded file
 *          <directory>    the root record, then one `dire` record per file
 *
 * Both the directory and each `dire` are chunk lists of their own, carrying
 * `type` (kind), `fnam` (NUL-padded name), `sz32` and `of32`. Note the endianness
 * flips: the outer .amxd chunks are u32**le**, everything inside mx@c is u32**be**,
 * and an inner chunk's length **includes** its own 8-byte header where an outer
 * one's does not. Reading either the wrong way still yields plausible-looking
 * offsets, so a parser that seems to half-work is probably doing this.
 *
 * `of32` is relative to the start of the ptch payload, not to the data region.
 */
export function parseFrozen(ptch: Buffer): { patcher: any; files: FrozenFile[] } {
  const headerSize = ptch.readUInt32BE(4);
  const dataLen = Number(ptch.readBigUInt64BE(8));
  const dir = ptch.subarray(headerSize + dataLen);

  /** Walk a chunk list, calling back with each id and its payload. */
  const walk = (buf: Buffer, fn: (id: string, body: Buffer) => void): void => {
    let o = 0;
    while (o + 8 <= buf.length) {
      const id = buf.toString('ascii', o, o + 4);
      const len = buf.readUInt32BE(o + 4);
      if (len < 8 || o + len > buf.length) break; // trailing padding, or we lost sync
      fn(id, buf.subarray(o + 8, o + len));
      o += len;
    }
  };

  const record = (buf: Buffer): FrozenFile | null => {
    let kind = '';
    let name = '';
    let size = -1;
    let offset = -1;
    walk(buf, (id, body) => {
      if (id === 'type') kind = body.toString('ascii').trim();
      else if (id === 'fnam') name = body.toString('utf8').replace(/\0+$/, '');
      else if (id === 'sz32') size = body.readUInt32BE(0);
      else if (id === 'of32') offset = body.readUInt32BE(0);
    });
    if (!name || size < 0 || offset < 0) return null;
    return { kind, name, data: ptch.subarray(offset, offset + size) };
  };

  // The root record describes the patcher itself; `dire` records describe its
  // dependencies. Both live in the same flat list.
  const files: FrozenFile[] = [];
  let patcherJson: Buffer | null = null;
  const root = record(dir);
  if (root) patcherJson = root.data;
  walk(dir, (id, body) => {
    if (id !== 'dire') return;
    const f = record(body);
    if (f) files.push(f);
  });

  if (!patcherJson) throw new Error('frozen device has no patcher record');
  return {
    patcher: JSON.parse(patcherJson.toString('utf8').replace(/\0+$/, '')),
    files,
  };
}

export function unpack(buf: Buffer): {
  type: string;
  patcher: any;
  /** Empty unless the device is frozen. */
  files: FrozenFile[];
} {
  const chunks: Record<string, Buffer> = {};
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

  if (chunks.ptch.subarray(0, 4).toString('ascii') === FROZEN_MAGIC) {
    return { type, ...parseFrozen(chunks.ptch) };
  }
  const json = chunks.ptch.toString('utf8').replace(/\0+$/, '');
  return { type, patcher: JSON.parse(json), files: [] };
}

// CLI ------------------------------------------------------------------
// pathToFileURL, not a `file://` template: it percent-encodes, and this repo
// lives under a path with a space in it. Comparing against the raw argv path
// made the whole CLI a silent no-op — it exited 0 having done nothing.
// The argv[1] check is not redundant: under `node -e` there is no script path,
// and pathToFileURL(undefined) throws — which made importing this module from a
// -e one-liner (the verification recipe in the README) die before it ran.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, input, output, type] = process.argv.slice(2) as [string, string, string, DeviceType];
  if (cmd === 'pack') {
    const patcher = JSON.parse(fs.readFileSync(input, 'utf8'));
    fs.writeFileSync(output, pack(patcher, type || 'audio'));
    console.log(`packed ${input} -> ${output}`);
  } else if (cmd === 'unpack') {
    const { type: t, patcher, files } = unpack(fs.readFileSync(input));
    fs.writeFileSync(output, JSON.stringify(patcher, null, '\t'));
    const frozen = files.length ? `, ${files.length} embedded files dropped` : '';
    console.log(`unpacked ${input} (${t}${frozen}) -> ${output}`);
  } else if (cmd === 'inspect') {
    const { type: t, files } = unpack(fs.readFileSync(input));
    if (!files.length) {
      console.log(`${input} (${t}) — not frozen, no embedded files`);
    } else {
      console.log(`${input} (${t}) — frozen, ${files.length} embedded files:`);
      for (const f of files) {
        console.log(`  ${f.kind.padEnd(4)} ${String(f.data.length).padStart(9)}  ${f.name}`);
      }
    }
  } else {
    console.error('usage: amxd.ts pack <in.maxpat> <out.amxd> [audio|midi|instrument]');
    console.error('       amxd.ts unpack <in.amxd> <out.maxpat>');
    console.error('       amxd.ts inspect <in.amxd>          list a frozen device\'s files');
    process.exit(1);
  }
}
