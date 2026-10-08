#!/usr/bin/env node
// Developer-only probes against a real Live set. Requires Live with Session
// Bridge loaded. Nothing in the built UI calls this path.
//
// THE ANSWERS APPEAR IN THE MAX WINDOW, not here — Options > Max > Open Max
// Window. These settle behavior that is visible only with Live open, so the
// readout has to be somewhere you can watch without leaving Live. This script
// only sends the message and exits.
//
//   npm run dev:diag -- ids            does goto('id N') resolve?
//   npm run dev:diag -- slot           is ClipSlot.color_index the clip's color?
//   npm run dev:diag -- sel            where is the cursor, how wide is the selection?
//   npm run dev:diag -- watch 1        log every selection change (then drag a clip)
//   npm run dev:diag -- watch 0        stop logging
//   npm run dev:diag -- scan 3         time one track's occupancy rescan
//   npm run dev:diag -- attach 4400    time attaching N slot observers
//   npm run dev:diag -- detach         release them
//   npm run dev:diag -- scroll 1       scroll Session down one step
//   npm run dev:diag -- scroll -1      scroll Session up one step
//   npm run dev:diag -- selectscene 42 select scene 42 directly (zero-based)
//   npm run dev:diag -- param          what Live thinks this device's parameters are
//   npm run dev:diag -- labels 8       write 8 synthetic value labels, then re-read
//   npm run dev:diag -- labelspaces    write two-word labels, spaced and non-breaking
//   npm run dev:diag -- bank           redefine the live.banks page, after a write

import type { Request } from '@openflow/protocol/index.ts';

const WHAT = new Set([
  'ids',
  'slot',
  'sel',
  'watch',
  'scan',
  'attach',
  'detach',
  'scroll',
  'selectscene',
  'param',
  'labels',
  'labelspaces',
  'bank',
]);
const SCROLL_MAX = 2000;
/** Matches the clamp in `diagPushLabels`; both are only there to bound a typo. */
const LABELS_MAX = 64;

const what = process.argv[2];
const arg = Number(process.argv[3] ?? 0);

if (!what || !WHAT.has(what)) {
  console.error(`usage: npm run dev:diag -- <${[...WHAT].join('|')}> [arg]`);
  process.exit(1);
}

if (what === 'scroll' && (!Number.isSafeInteger(arg) || arg === 0)) {
  console.error('usage: npm run dev:diag -- scroll <signed steps>');
  console.error('positive scrolls Session down; negative scrolls it up');
  process.exit(1);
}
if (what === 'scroll' && Math.abs(arg) > SCROLL_MAX) {
  console.error(`scroll is limited to ${SCROLL_MAX} steps per probe`);
  process.exit(1);
}
if (what === 'selectscene' && (!Number.isSafeInteger(arg) || arg < 0)) {
  console.error('usage: npm run dev:diag -- selectscene <zero-based scene index>');
  process.exit(1);
}
if (what === 'labels' && (!Number.isSafeInteger(arg) || arg < 0 || arg > LABELS_MAX)) {
  console.error(`usage: npm run dev:diag -- labels <0..${LABELS_MAX}>`);
  console.error('0 clears the list; any other count is sent whether or not the');
  console.error('parameter has room for it — that is the thing being measured');
  process.exit(1);
}

const url = process.env.OPENFLOW_WS || 'ws://127.0.0.1:17800/ws';
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
  if (what === 'scroll') {
    console.log(
      `Watch Live's Session View for ${Math.abs(arg)} vertical scroll step(s) ` +
        `${arg > 0 ? 'down' : 'up'}, issued 50ms apart.`,
    );
  }
  if (what === 'selectscene') {
    console.log(`Watch whether Live selects and reveals zero-based scene ${arg}.`);
  }
  if (what === 'labels' || what === 'labelspaces') {
    console.log(
      'Two lines follow in the Max window: what was sent, then what Live reports ' +
        'back. Compare min/max against items — a range that moved with a frozen ' +
        'item list means Max took the write and Live did not.',
    );
  }
}
