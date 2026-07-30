# tools/

Build tooling. Not compiled — Node 24 runs `.ts` directly via type stripping, so
these execute straight from source.

```
amxd.ts           pack / unpack .amxd containers  (library + CLI)
build-device.ts   generates the patcher and packs the device
```

```sh
npm run build:device        # writes bridge/SessionBridge.{amxd,maxpat}
node tools/amxd.ts unpack <in.amxd> <out.maxpat>
node tools/amxd.ts pack <in.maxpat> <out.amxd> [audio|midi|instrument]
```

Type stripping means these files are **not type-checked when they run**.
`npm run typecheck` covers them via `tools/tsconfig.json`. Keep the syntax erasable —
no enums, no runtime `namespace`, no decorators.

## The .amxd container format

Undocumented by Ableton. Decoded by dissecting the templates Live ships in
`Ableton Live 12 Suite.app/Contents/App-Resources/Misc/Max Devices/`, and verified
byte-for-byte against them.

An `.amxd` is a chunked wrapper around a plain `.maxpat` JSON patcher:

```
"ampf"  u32le(4)   <4-byte device type>
"meta"  u32le(4)   00 00 00 00
"ptch"  u32le(n)   <utf-8 maxpat json> 0x00      ← n includes the NUL
```

Each chunk is a 4-byte ASCII id, a little-endian u32 length, then that many bytes.

**Device type is the `ampf` payload:**

| bytes | device |
|---|---|
| `aaaa` | audio effect |
| `mmmm` | MIDI effect |
| `iiii` | instrument |

Protected factory devices use a **`ciph`** chunk (encrypted) and `meta` = 7 instead of
0. `unpack` will throw on those — expected, not a bug.

## The device generator

`build-device.ts` constructs the patcher programmatically rather than storing a
hand-edited `.maxpat`. Boxes get ids from a counter, `connect()` records patchlines,
and the whole thing serializes at the end. It also writes `SessionBridge.maxpat`
alongside the `.amxd` so you can open the same patch in Max to debug.

### Patch topology

```
[live.thisdevice] ─> [init(  ─────────────> [s ---bsv-to-lom]
[node.script] out0 ──────────────────────-> [s ---bsv-to-lom]

[r ---bsv-to-lom] ─> [route serving] ─┬─ matched ──> status text
                                      └─ rest ─────> [deferlow] ─> [v8 lom.js]
[v8 lom.js] ────────────────────────────────────────> [s ---bsv-to-node]

[r ---bsv-to-node] ─┬─> [node.script] in0
                    └─> [route ready] ──> status text

[plugin~] ─> [plugout~]                                  audio passthrough
```

Notes that matter if you edit this:

- **`send`/`receive` break the request/response cycle.** Wiring `node.script` and `v8`
  directly to each other would be a graph loop.
- **`deferlow` on the way into `v8`** gets LOM work off the incoming message's call
  stack.
- **`live.thisdevice` fires `init`** — LiveAPI is unsafe before the device is fully
  loaded.
- **`[route serving]`** peels off the status message so it never reaches `v8` and trips
  the unhandled-message log.
- **`plugin~` and `plugout~` are both 2-in/2-out `signal`**, copied verbatim from
  Live's own template. Getting these wrong breaks the audio path.
- **Presentation view is the only thing Live shows.** `openinpresentation: 1`, and each
  visible box needs `presentation: 1` plus `presentation_rect`. Everything else is
  hidden.
- **`live.text` needs `mode: 0`.** The default is `1` (Toggle), which fires on both
  press and release — the browser would open twice per click.
- The launch button sends `; max launchbrowser http://127.0.0.1:17800`.

### Verifying a patcher change

There's no schema validation, and Max fails quietly on a malformed patch. After
editing, check that every patchline endpoint exists and every inlet/outlet index is
within range for its object:

```sh
node --disable-warning=ExperimentalWarning -e '
const fs=require("fs");
import("./tools/amxd.ts").then(({unpack})=>{
  const p=unpack(fs.readFileSync("bridge/SessionBridge.amxd")).patcher.patcher;
  const byId=Object.fromEntries(p.boxes.map(b=>[b.box.id,b.box]));
  let bad=0;
  for(const {patchline:l} of p.lines){
    const s=byId[l.source[0]], d=byId[l.destination[0]];
    if(!s||!d){console.log("dangling",l);bad++;continue}
    if(l.source[1]>=(s.numoutlets??1)){console.log("bad outlet",s.text,l.source[1]);bad++}
    if(l.destination[1]>=(d.numinlets??1)){console.log("bad inlet",d.text,l.destination[1]);bad++}
  }
  console.log("wiring errors:",bad,"| presentation:",p.openinpresentation);
});'
```
