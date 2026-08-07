#!/usr/bin/env node
// Developer-only probes against a real Live set. Requires Live with Session
// Bridge loaded. Nothing in the built UI calls this path.
//
// THE ANSWERS APPEAR IN THE MAX WINDOW, not here — Options > Max > Open Max
// Window. Every question these settle is about what Live does *while you drag
// something in it*, so the readout has to be somewhere you can watch without
// leaving Live. This script only sends the message and exits.
//
//   npm run dev:diag -- ids            does goto('id N') resolve?
//   npm run dev:diag -- slot           is ClipSlot.color_index the clip's color?
//   npm run dev:diag -- sel            where is the cursor, how wide is the selection?
//   npm run dev:diag -- watch 1        log every selection change (then drag a clip)
//   npm run dev:diag -- watch 0        stop logging
//   npm run dev:diag -- scan 3         time one track's occupancy rescan
//   npm run dev:diag -- attach 4400    time attaching N slot observers
//   npm run dev:diag -- detach         release them

import type { Request } from '../protocol/index.ts';

const WHAT = new Set(['ids', 'slot', 'sel', 'watch', 'scan', 'attach', 'detach']);

const what = process.argv[2];
const arg = Number(process.argv[3] ?? 0);

if (!what || !WHAT.has(what)) {
  console.error(`usage: npm run dev:diag -- <${[...WHAT].join('|')}> [arg]`);
  process.exit(1);
}

const url = process.env.BSV_WS || 'ws://127.0.0.1:17800/ws';
const ws = new WebSocket(url);

await new Promise<void>((resolve, reject) => {
  ws.addEventListener('open', () => resolve(), { once: true });
  ws.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)), {
    once: true,
  });
});

ws.send(JSON.stringify({ id: 1, type: 'diag', what, arg } satisfies Request));

// The bridge answers an unready LOM on the wire; everything else goes to Max.
// Give that error a moment to arrive rather than closing on top of it.
const failure = await new Promise<string | null>((resolve) => {
  const timer = setTimeout(() => resolve(null), 400);
  ws.addEventListener('message', (message) => {
    const parsed = JSON.parse(String(message.data)) as { type?: string; message?: string };
    if (parsed.type === 'error') {
      clearTimeout(timer);
      resolve(parsed.message || 'bridge reported an error with no message');
    }
  });
});

ws.close();

if (failure) {
  console.error(`diag ${what}: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`sent: diag ${what}${process.argv[3] ? ` ${arg}` : ''}`);
  console.log('Answer is in the Max window — Options > Max > Open Max Window.');
  if (what === 'watch' && arg === 1) {
    console.log(
      'Now drag a clip from one slot to another in Live. TWO lines (source, ' +
        'then target) is what the selection-driven resync needs; one line ' +
        'means the source slot would go stale.',
    );
  }
}
