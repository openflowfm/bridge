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
//   [live.text] -> [; max launchbrowser ...(              (the launch button)
//   [plugin~] -> [plugout~]                                (audio passthrough)
//
// Presentation view — all Live shows is a title, a launch button and a status
// line. Everything above is hidden.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack } from './amxd.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'bridge');

const URL_ = 'http://127.0.0.1:17800';
const DEVICE_W = 244;

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

const pres = (r: number[]) => ({ presentation: 1, presentation_rect: r });

box('live.comment', 'SESSION BRIDGE', [520, 40, 160, 20], {
  numinlets: 1,
  numoutlets: 0,
  fontsize: 9.0,
  ...pres([12, 12, 160, 16]),
});

const launch = box('live.text', 'Open Session Manager', [520, 70, 200, 34], {
  numinlets: 1,
  // Two outlets, always: left is the value, right is the button text. Declaring
  // one here doesn't make the second disappear, it just makes the patch lie.
  numoutlets: 2,
  outlettype: ['', ''],
  // 0 = Button (momentary), 1 = Toggle. A launch is an action, not a state, so
  // Button — but see the wiring: Button mode bangs, it does not send 1.
  mode: 0,
  parameter_enable: 0,
  fontsize: 11.0,
  text: 'Open Session Manager',
  texton: 'Open Session Manager',
  ...pres([12, 36, 220, 34]),
});

const status = box('live.comment', 'starting…', [520, 116, 200, 20], {
  numinlets: 1,
  numoutlets: 0,
  fontsize: 9.0,
  varname: 'status',
  ...pres([12, 78, 220, 16]),
});

box('live.comment', '127.0.0.1:17800', [520, 146, 200, 20], {
  numinlets: 1,
  numoutlets: 0,
  fontsize: 9.0,
  ...pres([12, 96, 220, 16]),
});

// ---------------------------------------------------------------------
// Patching view — the machinery
// ---------------------------------------------------------------------

comment('Session Bridge — Live Object Model over WebSocket', [20, 14, 420, 20], {
  fontsize: 13.0,
  fontface: 1,
});

const thisdevice = obj('live.thisdevice', [20, 58, 110, 22], 1, 3);
const initMsg = msg('init', [20, 90, 40, 22]);

const rToNode = obj('r ---bsv-to-node', [20, 130, 130, 22], 0, 1);
const nodeScript = obj('node.script bridge.js @autostart 1 @watch 1', [20, 164, 300, 22], 1, 2);
const sToLom = obj('s ---bsv-to-lom', [20, 202, 120, 22], 1, 0);

const rToLom = obj('r ---bsv-to-lom', [370, 58, 120, 22], 0, 1);
const routeServing = obj(
  'route serving device_state_get device_state_set',
  [370, 90, 310, 22],
  1,
  4,
);
const deferlow = obj('deferlow', [440, 124, 70, 22], 1, 1);
const v8 = obj('v8 lom.js', [440, 156, 100, 22], 1, 1);
const sToNode = obj('s ---bsv-to-node', [440, 190, 130, 22], 1, 0);

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
comment('stored in the Live Set — roles + allowed colors', [370, 274, 310, 20], {
  fontsize: 10.0,
});

// status wiring
const routeReady = obj('route ready', [180, 130, 100, 22], 1, 2);
const msgServing = msg('set "server up"', [370, 124, 120, 22]);
const msgReady = msg('set "connected to Live"', [180, 164, 160, 22]);
const msgLaunch = msg(`; max launchbrowser ${URL_}`, [520, 200, 260, 22]);

comment('LOM side (v8)', [370, 38, 140, 20], { fontsize: 10.0 });
comment('server side (node)', [20, 110, 160, 20], { fontsize: 10.0 });

const pluginIn = obj('plugin~', [20, 300, 62, 22], 2, 2, { outlettype: ['signal', 'signal'] });
const pluginOut = obj('plugout~', [20, 334, 68, 22], 2, 2, { outlettype: ['signal', 'signal'] });
comment('audio passthrough — device is inert on the signal path', [96, 316, 340, 20], {
  fontsize: 10.0,
});

// --- wiring -----------------------------------------------------------
connect(thisdevice, 0, initMsg, 0);
connect(initMsg, 0, sToLom, 0);
connect(nodeScript, 0, sToLom, 0);
connect(rToNode, 0, nodeScript, 0);

connect(rToLom, 0, routeServing, 0);
connect(routeServing, 0, msgServing, 0); // matched "serving"
connect(routeServing, 1, deviceState, 0); // get -> bang -> current stored value
connect(routeServing, 2, deviceState, 0); // set -> new base64url symbol
connect(routeServing, 3, deferlow, 0); // everything else -> LOM
connect(msgServing, 0, status, 0);

connect(deferlow, 0, v8, 0);
connect(v8, 0, sToNode, 0);
connect(deviceState, 0, prependDeviceState, 0);
connect(prependDeviceState, 0, sToNode, 0);

connect(rToNode, 0, routeReady, 0);
connect(routeReady, 0, msgReady, 0);
connect(msgReady, 0, status, 0);

// Straight into the message box. In Button mode live.text's left outlet emits a
// *bang* on click — the text goes out the right outlet — so the `sel 1` that
// used to sit here matched nothing and the button did nothing. `sel 1` is for
// Toggle mode, which is the one mode this button must not be in.
connect(launch, 0, msgLaunch, 0);

connect(pluginIn, 0, pluginOut, 0);
connect(pluginIn, 1, pluginOut, 1);

// --- patcher ----------------------------------------------------------
const patcher = {
  patcher: {
    fileversion: 1,
    appversion: { major: 9, minor: 1, revision: 4, architecture: 'x64', modernui: 1 },
    classnamespace: 'box',
    rect: [80, 100, 840, 460],
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
    description:
      'Exposes the Live Object Model over a local WebSocket, and serves the Session Manager UI.',
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
