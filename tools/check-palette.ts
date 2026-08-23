#!/usr/bin/env node
// Developer-only verification for core/src/livePalette.ts.
//
// Requires Live with Session Bridge loaded. The bridge creates one scratch MIDI
// track and clip, walks color_index, removes the track, and returns Live's table.
// Nothing in the built UI calls this path.

import { LIVE_PALETTE } from '@openflow/core/livePalette.ts';
import type { Event, EventOf, Request } from '@openflow/protocol/index.ts';

const url = process.env.OPENFLOW_WS || 'ws://127.0.0.1:17800/ws';
const ws = new WebSocket(url);

await new Promise<void>((resolve, reject) => {
  ws.addEventListener('open', () => resolve(), { once: true });
  ws.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)), {
    once: true,
  });
});

ws.send(JSON.stringify({ id: 1, type: 'palette' } satisfies Request));

const event = await new Promise<EventOf<'palette'>>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('palette diagnostic timed out')), 30_000);
  ws.addEventListener('message', (message) => {
    const parsed = JSON.parse(String(message.data)) as Event;
    if (parsed.type === 'error' && parsed.id === 1) {
      clearTimeout(timer);
      reject(new Error(parsed.message));
    }
    if (parsed.type === 'palette' && parsed.id === 1) {
      clearTimeout(timer);
      resolve(parsed);
    }
  });
});

ws.close();

const expected = Array.from(LIVE_PALETTE);
const mismatch = Math.max(expected.length, event.colors.length);
let firstMismatch = -1;
for (let i = 0; i < mismatch; i++) {
  if (expected[i] !== event.colors[i]) {
    firstMismatch = i;
    break;
  }
}

if (firstMismatch < 0) {
  console.log(`Live palette matches all ${expected.length} embedded colors.`);
} else {
  console.error(
    `Live palette differs at index ${firstMismatch}: embedded ` +
      `${expected[firstMismatch]?.toString(16) ?? '(missing)'}, Live ` +
      `${event.colors[firstMismatch]?.toString(16) ?? '(missing)'}.`,
  );
  console.error('Live currently reports:');
  for (let i = 0; i < event.colors.length; i += 14) {
    console.error(
      event.colors.slice(i, i + 14).map((rgb) => `0x${rgb.toString(16).padStart(6, '0')}`).join(', '),
    );
  }
  process.exitCode = 1;
}
