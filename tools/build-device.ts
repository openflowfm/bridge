#!/usr/bin/env node
// Builds bridge/SessionBridge.amxd (and a .maxpat alongside it for debugging).
//
// Patching view — send/receive deliberately break the request/response cycle
// so Max never sees a graph loop:
//
//   [live.thisdevice] -> [init(  -> [s ---bsv-to-lom]
//   [node.script] out0 ---------> [s ---bsv-to-lom]
//   [r ---bsv-to-lom] -> [route serving device_state_get device_state_set]
//                         serving -> status text; state get/set -> stored pattr
//                         unmatched -> [deferlow] -> [v8 lom.js]
//   [pattr bsv-state] -> [prepend device_state] -> [s ---bsv-to-node]
//   [v8 lom.js] -> [s ---bsv-to-node]
//   [r ---bsv-to-node] -> [node.script] in0  and  -> [route ready] -> status text
//   [live.text] -> [; max launchbrowser ...(              (launch, and GitHub)
//   [plugin~] -> [plugout~]                                (audio passthrough)
//
// Presentation view — a display panel reading status and address, the launch
// button, and a footer carrying the version and a link out. Everything above
// is hidden. See the layout note above the presentation section.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack } from './amxd.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'bridge');

const URL_ = 'http://127.0.0.1:17800';
const REPO = 'https://github.com/ryangavin/better-session-view';
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

// Live fixes the height of a device at 169px; every factory Max device it ships
// is laid out in exactly that box, so anything below it is simply not drawn.
const DEVICE_W = 244;
const DEVICE_H = 169;

let n = 0;
type Box = { box: Record<string, unknown> };
type Line = { patchline: { destination: [string, number]; source: [string, number] } };
const boxes: Box[] = [];
const lines: Line[] = [];

function box(
  maxclass: string,
  text: string | null,
  rect: number[],
  extra: Record<string, unknown> = {},
): string {
  const id = `obj-${++n}`;
  boxes.push({
    box: { id, maxclass, patching_rect: rect, ...(text !== null ? { text } : {}), ...extra },
  });
  return id;
}

const obj = (
  text: string,
  rect: number[],
  ins: number,
  outs: number,
  extra: Record<string, unknown> = {},
) =>
  box('newobj', text, rect, {
    numinlets: ins,
    numoutlets: outs,
    outlettype: Array(outs).fill(''),
    ...extra,
  });

const msg = (text: string, rect: number[], extra: Record<string, unknown> = {}) =>
  box('message', text, rect, { numinlets: 2, numoutlets: 1, outlettype: [''], ...extra });

const comment = (text: string, rect: number[], extra: Record<string, unknown> = {}) =>
  box('comment', text, rect, { numinlets: 1, numoutlets: 0, ...extra });

const connect = (src: string, outlet: number, dst: string, inlet: number) =>
  lines.push({ patchline: { destination: [dst, inlet], source: [src, outlet] } });

// ---------------------------------------------------------------------
// Presentation view — the only thing visible in Live
// ---------------------------------------------------------------------
//
//   0  ┌────────────────────────────────┐  display panel, live_lcd_bg
//      │ Status                         │  dim label
//      │ 1 connection                   │  how many clients are attached
//      │ ──────────────────────────────  │
//      │ Address         127.0.0.1:17800│  label left, value right
//  86  └────────────────────────────────┘
//  98    ╭──────────────────────────────╮
//        │     Open Session Manager     │
// 128    ╰──────────────────────────────╯
// 139    Better Session View 0.1.0  GitHub
// 169
//
// The device's own name is not repeated anywhere: Live already draws it in the
// title bar above, and every stock device leaves that job to Live.

const pres = (r: number[]) => ({ presentation: 1, presentation_rect: r });

// Live's UI font, under the family name Max resolves it by. A plain `comment`
// left alone draws in the *patcher* font, and that one detail is most of what
// makes a hand-built device read as a Max patch instead of part of Live. The
// `live.*` objects already draw in it, which is why they never set it.
const LIVE_FONT = 'Ableton Sans Medium';

// Cached fallbacks for the theme colors below, in case an expression can't be
// resolved. Values are Max's own defaults from interfaces/maxcolors.json.
const LCD_BG = [0.156863, 0.156863, 0.156863, 1.0];
const LCD_FRAME = [0.313725, 0.313725, 0.313725, 1.0];
const LCD_TITLE = [0.807843, 0.807843, 0.807843, 1.0];
const LCD_DIM = [0.54902, 0.54902, 0.54902, 1.0];

/**
 * Text drawn over the display panel.
 *
 * **The panel stays dark in Live's light theme, so text on it cannot use the
 * surface text color.** `live.comment` takes exactly that color and no other,
 * which puts black on near-black the moment someone switches themes. A plain
 * `comment` bound to the `live_lcd_*` family is what Ableton's own devices use
 * for the same reason, and it buys the dim-label / bright-value split as well.
 *
 * `expression` is what Live redraws from when the theme changes; the literal
 * alongside it is only the cached fallback.
 */
const lcdText = (
  text: string,
  patchRect: number[],
  presRect: number[],
  opts: { size?: number; tone?: 'title' | 'dim'; align?: 0 | 2; varname?: string } = {},
) => {
  const [color, cached] =
    opts.tone === 'title'
      ? (['live_lcd_title', LCD_TITLE] as const)
      : (['live_lcd_control_fg_zombie', LCD_DIM] as const);
  return box('comment', text, patchRect, {
    numinlets: 1,
    numoutlets: 0,
    fontname: LIVE_FONT,
    fontsize: opts.size ?? 9.5,
    textcolor: cached,
    saved_attribute_attributes: { textcolor: { expression: `themecolor.${color}` } },
    ...(opts.align ? { textjustification: opts.align } : {}),
    ...(opts.varname ? { varname: opts.varname } : {}),
    ...pres(presRect),
  });
};

/** A button that opens a URL. Both of ours are one. */
const linkButton = (
  label: string,
  info: string,
  patchRect: number[],
  presRect: number[],
  fontsize: number,
) =>
  box('live.text', label, patchRect, {
    numinlets: 1,
    // Two outlets, always: left is the value, right is the button text. Declaring
    // one here doesn't make the second disappear, it just makes the patch lie.
    numoutlets: 2,
    outlettype: ['', ''],
    // 0 = Button (momentary), 1 = Toggle. Opening a URL is an action, not a
    // state, so Button — but see the wiring: Button mode bangs, it does not
    // send 1.
    mode: 0,
    parameter_enable: 0,
    fontsize,
    texton: label,
    // What Live's Info View reads out on hover. Stock devices annotate every
    // control; a device that leaves the panel blank announces that it isn't one.
    annotation_name: label,
    annotation: info,
    ...pres(presRect),
  });

// The display. `background: 1` keeps it in the background layer so it can't
// paint over the text; `bgfillcolor` is the attribute panel actually fills
// from, while `bgcolor` is the cached literal — the same split Ableton's own
// devices save.
box('panel', null, [520, 380, DEVICE_W, 86], {
  numinlets: 1,
  numoutlets: 0,
  mode: 0,
  background: 1,
  rounded: 4,
  bgcolor: LCD_BG,
  saved_attribute_attributes: { bgfillcolor: { expression: 'themecolor.live_lcd_bg' } },
  // Bleeds to both edges, the way Ableton's own panels do — a device face has
  // no outer margin.
  ...pres([0, 0, DEVICE_W, 86]),
});

lcdText('Status', [530, 390, 100, 16], [10, 10, 100, 16]);
const status = lcdText('Starting…', [530, 406, 224, 20], [10, 26, 224, 20], {
  size: 12.0,
  tone: 'title',
  varname: 'status',
});

box('live.line', null, [530, 432, 224, 8], {
  numinlets: 1,
  numoutlets: 0,
  // Where the rule sits inside its box: 0 draws it against the top edge, 1
  // centers it. Centered, so the 8px box reads as the gap it looks like.
  justification: 1,
  linecolor: LCD_FRAME,
  saved_attribute_attributes: { linecolor: { expression: 'themecolor.live_lcd_frame' } },
  ...pres([10, 52, 224, 8]),
});

lcdText('Address', [530, 442, 70, 16], [10, 62, 70, 16]);
lcdText('127.0.0.1:17800', [614, 442, 140, 16], [94, 62, 140, 16], { tone: 'title', align: 2 });

const launch = linkButton(
  'Open Session Manager',
  'Open the Session Manager in your browser, at 127.0.0.1:17800.',
  [526, 478, 232, 30],
  [6, 98, 232, 30],
  11.0,
);

// The footer sits on the device surface rather than the display, so this one is
// a `live.comment` with no color set — that is already the surface text color,
// in whichever theme Live is wearing.
box('live.comment', `Better Session View ${VERSION}`, [528, 522, 150, 16], {
  numinlets: 1,
  numoutlets: 0,
  fontsize: 9.0,
  ...pres([8, 142, 150, 16]),
});

const github = linkButton(
  'GitHub',
  'Open the Better Session View project page on GitHub.',
  [698, 519, 60, 20],
  [176, 139, 62, 20],
  10.0,
);

// ---------------------------------------------------------------------
// Patching view — the machinery
// ---------------------------------------------------------------------

comment('Session Bridge — Live Object Model over WebSocket', [20, 14, 420, 20], {
  fontsize: 13.0,
  fontface: 1,
});

const thisdevice = obj('live.thisdevice', [20, 58, 110, 22], 1, 3);
// `lom.js` can autowatch-reload without the device reloading. Remember outside
// the script whether live.thisdevice has completed once, then let lom.js's
// private `boot` signal replay init only when that is safe. `t b b` fires
// right-to-left: set the latch first, then send the initial init.
const initTrigger = obj('t b b', [20, 90, 48, 22], 1, 2);
const initMsg = msg('init', [20, 122, 40, 22]);
const markInitialized = msg('1', [76, 122, 30, 22]);
const initialized = obj('i 0', [700, 286, 36, 22], 2, 1);
const selectInitialized = obj('sel 1', [746, 286, 44, 22], 1, 2);

const rToNode = obj('r ---bsv-to-node', [20, 130, 130, 22], 0, 1);
const nodeScript = obj('node.script bridge.js @autostart 1 @watch 1', [20, 164, 300, 22], 1, 2);
const sToLom = obj('s ---bsv-to-lom', [20, 202, 120, 22], 1, 0);

const rToLom = obj('r ---bsv-to-lom', [370, 58, 120, 22], 0, 1);
const routeStatus = obj(
  'route status device_state_get device_state_set push_label',
  [370, 90, 340, 22],
  1,
  5,
);
const deferlow = obj('deferlow', [440, 124, 70, 22], 1, 1);
const v8 = obj('v8 lom.js', [440, 156, 100, 22], 1, 1);
// `boot` is patcher-private. Everything else continues to Node unchanged.
const routeV8Boot = obj('route boot', [440, 190, 76, 22], 1, 2);
const sToNode = obj('s ---bsv-to-node', [530, 190, 130, 22], 1, 0);

// One opaque, versioned JSON blob encoded as a base64url symbol. Parameter
// type 3 is Max for Live's Blob type; parameter_invisible makes it Stored Only,
// so Live saves it in the .als without offering meaningless automation.
// `restore` is the new-device sentinel — bridge.ts replaces it with migrated or
// default state the first time it asks.
const deviceState = obj('pattr bsv-state', [370, 244, 110, 22], 1, 3, {
  varname: 'bsv-state',
  restore: [0.0],
  saved_object_attributes: { parameter_enable: 1 },
  saved_attribute_attributes: {
    valueof: {
      parameter_steps: 0,
      parameter_exponent: 1.0,
      parameter_invisible: 1,
      parameter_unitstyle: 10,
      parameter_annotation_name: '',
      parameter_mmax: 127.0,
      parameter_mmin: 0.0,
      parameter_type: 3,
      parameter_initial_enable: 0,
      parameter_shortname: 'bsv-state',
      parameter_modmax: 127.0,
      parameter_longname: 'bsv-state',
      parameter_modmin: 0.0,
      parameter_linknames: 0,
      parameter_modmode: 0,
      parameter_info: 'Session Bridge set-owned configuration',
      parameter_units: '',
      parameter_order: 0,
      parameter_defer: 0,
      parameter_speedlim: 0.0,
    },
  },
});
const prependDeviceState = obj('prepend device_state', [500, 244, 150, 22], 1, 1);
comment('stored in the Live Set — default artist, roles + allowed colors', [370, 274, 310, 20], {
  fontsize: 10.0,
});

// Status wiring. bridge.ts sends one number and the patcher spells it: -1 while
// the LOM handshake is outstanding, otherwise the count of connected clients.
// Doing the wording here rather than in Node keeps every string a user reads in
// the file that draws them, and keeps the wire message a bare integer — no
// quoting, no symbol with a space in it to lose on the way across.
// One inlet, not two: `select` only grows the second inlet when it has a single
// argument to be set through it.
const selCount = obj('sel -1 0 1', [700, 90, 110, 22], 1, 4);
const msgWaiting = msg('set "Waiting for Live"', [700, 124, 160, 22]);
const msgNone = msg('set "No connections"', [700, 156, 160, 22]);
const msgOne = msg('set "1 connection"', [700, 188, 160, 22]);
// sprintf emits its "Formatted String as a Message", so this reaches the
// comment as `set 5 connections` — exactly the list `set` wants.
const fmtMany = obj('sprintf set %ld connections', [700, 220, 210, 22], 1, 1);

const msgLaunch = msg(`; max launchbrowser ${URL_}`, [160, 400, 300, 22]);
const msgGithub = msg(`; max launchbrowser ${REPO}`, [160, 432, 340, 22]);

comment('LOM side (v8)', [370, 38, 140, 20], { fontsize: 10.0 });
comment('server side (node)', [20, 110, 160, 20], { fontsize: 10.0 });
comment('presentation — laid out here the way Live draws it', [520, 356, 320, 20], {
  fontsize: 10.0,
});

const pluginIn = obj('plugin~', [20, 300, 62, 22], 2, 2, { outlettype: ['signal', 'signal'] });
const pluginOut = obj('plugout~', [20, 334, 68, 22], 2, 2, { outlettype: ['signal', 'signal'] });
comment('audio passthrough — device is inert on the signal path', [96, 316, 340, 20], {
  fontsize: 10.0,
});

// --- wiring -----------------------------------------------------------
connect(thisdevice, 0, initTrigger, 0);
connect(initTrigger, 1, markInitialized, 0);
connect(markInitialized, 0, initialized, 1);
connect(initTrigger, 0, initMsg, 0);
connect(initMsg, 0, sToLom, 0);
connect(nodeScript, 0, sToLom, 0);
connect(rToNode, 0, nodeScript, 0);

connect(rToLom, 0, routeStatus, 0);
connect(routeStatus, 0, selCount, 0); // matched "status" -> the connection count
connect(routeStatus, 1, deviceState, 0); // get -> bang -> current stored value
connect(routeStatus, 2, deviceState, 0); // set -> new base64url symbol
// outlet 3 (push_shortname) is wired in the Push song browser section below,
// where its destination is created; outlet 4 (everything else -> LOM) moved
// down there too so both stay next to each other.

connect(selCount, 0, msgWaiting, 0); // -1: LOM handshake outstanding
connect(selCount, 1, msgNone, 0); //  0
connect(selCount, 2, msgOne, 0); //  1 — the one that doesn't pluralize
connect(selCount, 3, fmtMany, 0); //  anything else, still carrying the number
connect(msgWaiting, 0, status, 0);
connect(msgNone, 0, status, 0);
connect(msgOne, 0, status, 0);
connect(fmtMany, 0, status, 0);

connect(deferlow, 0, v8, 0);
connect(v8, 0, routeV8Boot, 0);
connect(routeV8Boot, 0, initialized, 0);
connect(initialized, 0, selectInitialized, 0);
connect(selectInitialized, 0, initMsg, 0);
connect(routeV8Boot, 1, sToNode, 0);
connect(deviceState, 0, prependDeviceState, 0);
connect(prependDeviceState, 0, sToNode, 0);

// Straight into the message box. In Button mode live.text's left outlet emits a
// *bang* on click — the text goes out the right outlet — so the `sel 1` that
// used to sit here matched nothing and the button did nothing. `sel 1` is for
// Toggle mode, which is the one mode these buttons must not be in.
connect(launch, 0, msgLaunch, 0);
connect(github, 0, msgGithub, 0);

connect(pluginIn, 0, pluginOut, 0);
connect(pluginIn, 1, pluginOut, 1);

// ---------------------------------------------------------------------
// Push song browser — one Int parameter on a connected Push's encoder strip
// (via live.banks) whose *value* is a position in the running order and whose
// *label* is the song sitting at that position. Turn it and the name under
// your hand changes; the scene selection in Live follows.
//
// Two dead ends got us here, both worth not repeating:
//
//   - **Sixteen parameters, one song named into each `_parameter_shortname`.**
//     Capped the set at sixteen, spent eight encoders and two live.banks pages,
//     and came up generic on hardware — though with a song list that may never
//     have been built, so the label mechanism itself was never really on trial.
//
//   - **One Enum parameter whose values are the songs.** An Enum's items are
//     `parameter_enum`, which is *saved* metadata: Max has no `_parameter_enum`
//     runtime message at all, and `_parameter_range` on an Enum is taken as the
//     numeric min/max, so a two-song set rendered as `0` and `1`. The item list
//     of a live.menu cannot be changed while the device is loaded.
//
// What that second attempt did prove is that runtime parameter metadata reaches
// Push — the range changed under it, live. So the name travels as
// `_parameter_shortname` and only the *current* one is ever set, which is the
// one thing that doesn't need a list. No cap, one encoder, no paging.
//
// This patcher owns no size constant: the range arrives from bridge.ts sized to
// the set. See its "Push song browser" section.
// ---------------------------------------------------------------------

/** Positions on the encoder. Must match PUSH_SONG_MAX in bridge/src/bridge.ts. */
const PUSH_SONG_MAX = 128;
/** Stale banks to clear on load; more than any build has ever defined. */
const PUSH_BANK_CLEAR = 8;

comment('Push song browser — one Enum parameter, named by bridge.ts', [
  20, 536, 460, 20,
], { fontsize: 10.0 });

connect(routeStatus, 4, deferlow, 0); // everything else -> LOM

// A real Live-visible parameter — that's what makes it addressable by
// live.banks (by name) and what makes Live route encoder turns to it.
//
// **`live.menu` rather than `live.numbox`, and the object is load-bearing.**
// Both declare a Live parameter and both appear in the bank, but on Push only
// this one has ever *bound* to an encoder. As a `live.numbox` typed Int the
// encoder sat at 0 and a touch fell straight through to the armed track as a
// MIDI note — which is what Push does with a control it hasn't claimed. As a
// `live.menu` the same encoder turned, moved and reported. Whatever the reason,
// don't swap the object back without a Push in front of you.
//
// The Enum's items are vestigial: `parameter_enum` is *saved* metadata that
// cannot be rewritten at runtime, and bridge.ts's `_parameter_range` replaces
// the whole thing with a numeric span sized to the set. Which is fine — the
// value is a position and the *name* is the song, and the name is the one piece
// of metadata that does travel. One item is declared here only because a
// parameter of this type must have at least one before it is sized.
//
// `parameter_longname` is the one piece of metadata that must never change:
// live.banks addresses this parameter by that name, and it is the identity Live
// maps automation and MIDI to.
const songMenu = box('live.menu', null, [20, 570, 120, 15], {
  numinlets: 1,
  numoutlets: 3,
  outlettype: ['', '', 'float'],
  varname: 'Song',
  parameter_enable: 1,
  saved_attribute_attributes: {
    valueof: {
      parameter_type: 2,
      // One item per position, fixed at build time, because that is the only
      // time an Enum's items can be set. The item text is the position number:
      // the *name* of what is there travels separately and changes with the set,
      // but how many places there are to stand cannot.
      parameter_enum: Array.from({ length: PUSH_SONG_MAX }, (_, i) => String(i + 1)),
      // **Never a zero-width range.** A control surface normalizes a value to
      // draw it, which divides by `mmax - mmin` and by `steps - 1`; declared
      // 0…0 with one step, this crashed Push the instant it tried to draw the
      // device, before a single message had arrived. Two positions is the
      // narrowest this may ever legally be — see the floors in bridge.ts, which
      // hold the same line for the runtime range.
      parameter_mmax: PUSH_SONG_MAX - 1,
      parameter_steps: PUSH_SONG_MAX,
      parameter_initial_enable: 1,
      parameter_initial: [0.0],
      // **Push displays the long name, not the short one.** It read `bsv-song`
      // on hardware while the short name said something else entirely — which
      // also settles what v1 was chasing: `_parameter_shortname` never had a
      // chance of being seen. So this is a word rather than an identifier, and
      // it is what the live.banks message below has to address the parameter by.
      parameter_longname: 'Song',
      parameter_shortname: 'Song',
      parameter_annotation_name: 'Song',
      // Unlinked deliberately: the scripting name is the patcher's handle on
      // this object and should not follow the display name around.
      parameter_linknames: 0,
      parameter_info:
        "The set's songs, in running order. Turning this selects that song's " +
        'first scene in Live — it does not fire anything.',
      parameter_order: 1,
      parameter_modmode: 0,
      parameter_defer: 0,
    },
  },
});

// Outgoing: the selected index. Unlike v1's pool this parameter holds a
// meaningful value, so there is nothing to reset — the encoder's position *is*
// where you are in the set, and it should stay there between turns.
const prependSong = obj('prepend push_song', [160, 570, 110, 22], 1, 1);
connect(songMenu, 0, prependSong, 0); // outlet 0 is the item index
connect(prependSong, 0, sToNode, 0);

// Incoming, naming: `push_label <name>` — the song at the current position.
// Only ever one name, which is why this survives where a whole list could not.
const prependLabel = obj('prepend _parameter_shortname', [700, 536, 170, 22], 1, 1);
connect(routeStatus, 3, prependLabel, 0);
connect(prependLabel, 0, songMenu, 0);

// **The range is not sized at runtime, because it can't be.** On hardware
// `_parameter_range` propagated and `_parameter_steps` did not, which left a
// 34-song set spanning 0…33 in two detents. So the span and the detent count
// are both baked above at PUSH_SONG_MAX and never touched again: one detent is
// always one position, and positions past the end of the set read `no songs`
// and jump nowhere. That also means no metadata write can resize this
// parameter while Push is drawing it, which is the thing that crashed it.
comment('live.banks — cleared, then one page, fired once at init', [20, 610, 340, 20], {
  fontsize: 10.0,
});
const banks = obj('live.banks', [20, 634, 90, 22], 1, 1);

// **Banks are saved with the device, and `new` inserts rather than replaces.**
// Firing `new 0` on every load pushes the previous bank to index 1, then 2 —
// which is where the empty "bank 2" on hardware came from, a fossil of the two
// pages an older build defined. Deleting index 0 repeatedly empties the list
// however many are stacked up, because a delete decrements everything above it.
const banksReset = msg('delete 0', [130, 666, 80, 22]);
const banksClear = obj(`uzi ${PUSH_BANK_CLEAR}`, [130, 698, 70, 22], 2, 3);
const banksNew = msg('new 0 Songs Song', [130, 634, 260, 22]);
// Right to left: clear every stale bank, and only then define ours.
const banksOrder = obj('t b b', [20, 602, 50, 22], 1, 2);
connect(thisdevice, 0, banksOrder, 0);
connect(banksOrder, 1, banksClear, 0);
connect(banksClear, 0, banksReset, 0);
connect(banksReset, 0, banks, 0);
connect(banksOrder, 0, banksNew, 0);
connect(banksNew, 0, banks, 0);

// --- patcher ----------------------------------------------------------
const patcher = {
  patcher: {
    fileversion: 1,
    appversion: { major: 9, minor: 1, revision: 4, architecture: 'x64', modernui: 1 },
    classnamespace: 'box',
    // The window opens on the presentation, so size it to the device. Ableton's
    // own devices all save this rect at devicewidth x 169, which makes opening
    // the .maxpat show you exactly what Live shows. The patching view is bigger
    // than the window and scrolls; that is the trade the factory devices make.
    rect: [80, 100, DEVICE_W, DEVICE_H],
    bglocked: 0,
    openinpresentation: 1,
    default_fontsize: 12.0,
    default_fontface: 0,
    default_fontname: 'Arial',
    gridonopen: 1,
    gridsize: [15.0, 15.0],
    gridsnaponopen: 1,
    objectsnaponopen: 1,
    statusbarvisible: 2,
    toolbarvisible: 1,
    lefttoolbarpinned: 0,
    toptoolbarpinned: 0,
    righttoolbarpinned: 0,
    bottomtoolbarpinned: 0,
    toolbars_unpinned_last_save: 0,
    tallnewobj: 0,
    boxanimatetime: 200,
    enablehscroll: 1,
    enablevscroll: 1,
    devicewidth: DEVICE_W,
    // Live reads these into the browser and the Info View, so they are user
    // copy, not a note to ourselves about WebSockets.
    description:
      'Connects this Live Set to Better Session View — naming, color and running order for large sets.',
    digest: 'Session Bridge',
    tags: 'session manager bridge',
    style: '',
    subpatcher_template: '',
    assistshowspatchername: 0,
    boxes,
    lines,
    // Max writes this index for every parameter-enabled object. Without it the
    // pattr has parameter metadata but Live does not register it with the
    // device, so there is nothing for the .als to save.
    parameters: {
      [deviceState]: ['bsv-state', 'bsv-state', 0],
      // The name here is the one Live registers the parameter under, and Push
      // reads it from Live — so it has to agree with `parameter_longname` on
      // the object. Left saying `bsv-song` after the object was renamed, it is
      // what Push kept displaying.
      [songMenu]: ['Song', 'Song', 1],
    },
    dependency_cache: [],
    autosave: 0,
  },
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'SessionBridge.maxpat'),
  JSON.stringify(patcher, null, '\t'),
);
fs.writeFileSync(path.join(outDir, 'SessionBridge.amxd'), pack(patcher, 'audio'));
console.log(
  `built bridge/SessionBridge.amxd — ${boxes.length} boxes, ${lines.length} lines, ` +
    `${boxes.filter((b) => b.box.presentation === 1).length} in presentation`,
);
