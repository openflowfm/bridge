# tools/

Build tooling. Not compiled — Node 24 runs `.ts` directly via type stripping, so
these execute straight from source.

```
amxd.ts                      pack / unpack / inspect .amxd containers  (library + CLI)
build-bridge.ts              bundles bridge.js — ws and the built UI inlined
build-device.ts              generates the patcher and packs the device
lom-reference.ts             regenerates bridge/LOM.md
lom-reference.preamble.md    the hand-written half of bridge/LOM.md
wiki-sync.ts                 renders docs/ into flat wiki pages
```

```sh
npm run build:bridge        # writes bridge/bridge.js (bundled) and bridge/lom.js
npm run build:device        # writes bridge/SessionBridge.{amxd,maxpat}
npm run build:lom           # writes bridge/LOM.md
node tools/amxd.ts unpack <in.amxd> <out.maxpat>
node tools/amxd.ts pack <in.maxpat> <out.amxd> [audio|midi|instrument]
node tools/amxd.ts inspect <in.amxd>          # list a frozen device's inlined files
```

**The CLI compares `import.meta.url` against `pathToFileURL(process.argv[1])`, not a
`file://` template.** `import.meta.url` percent-encodes, so under a path containing a
space the naive comparison is false and every command becomes a silent no-op that still
exits 0. This repo lives at `.../The Source/...`; the CLI had never once run here.

Type stripping means these files are **not type-checked when they run**.
`npm run typecheck` covers them via `tools/tsconfig.json`. Keep the syntax erasable —
no enums, no runtime `namespace`, no decorators.

## The LOM reference

`lom-reference.ts` scrapes Cycling '74's LOM page into [`bridge/LOM.md`](../bridge/LOM.md),
splicing in `lom-reference.preamble.md` above the generated tables. Run it after a Live
upgrade. The download is cached in `node_modules/.cache/lom.html`; delete that to refetch.

Two things about it are deliberate:

- **It parses the page's `liveapi_*` class names, not flattened text.** Once the tags
  are gone a function name and one of its parameter names are the same shape, and a
  text parser reads `create_scene`'s `index` argument as a sibling function. The first
  version did exactly that and invented four `Song` methods.
- **It asserts its own output.** The page declares how many children, properties and
  functions it contains via those same class names, so the parser counts them and
  throws if the emitted total disagrees. A reference that silently drops members is
  worse than no reference, because you'd trust it.

The page is pinned to **Live 12.1** and we run 12.4.3, so it is not the last word.
`LOM.md` records what Live's own binary adds and contradicts; the recipe for checking a
single name against the installed version is in there too.

## The wiki sync

`wiki-sync.ts` renders [`../docs/`](../docs/README.md) into the shape a GitHub wiki
wants, and `.github/workflows/wiki.yml` pushes the result on every change to `docs/`.

**A wiki is a separate git repository** — `<repo>.wiki.git` — whose pages are flat and
addressed by filename with the `.md` dropped. So publishing is a rename plus a link
rewrite, not a copy. `PAGES` holds the mapping (`the-grid.md` → `Reading-the-grid`;
GitHub renders the hyphens as spaces), and `README.md` becomes `Home`, which is the
landing page.

Two things it refuses to do quietly, because both would ship a wiki that looks fine and
isn't:

- **A docs page with no entry in `PAGES` fails the run.** Otherwise a new page simply
  never appears on the wiki and nothing says so.
- **A link to an unmapped `.md` fails too.** It would render as a dead link on the wiki,
  where relative paths don't resolve the way they do in the repo.

It also writes `_Sidebar.md` (the reading order, which isn't alphabetical) and
`_Footer.md`, which tells anyone editing on github.com that their change will be
overwritten.

The wiki repository **does not exist until one page has been created through the web
UI**. Enabling the wiki in settings isn't enough; the clone 404s until then, and the
workflow says so rather than failing obscurely.

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

### Frozen devices

Live's Freeze button inlines every file a device depends on into the `.amxd` itself.
That's how a device you download as one file works, and it's the shape this project
wants to ship in. A frozen device keeps the same outer chunks, but the `ptch` payload is
no longer raw patcher JSON:

```
"mx@c"  u32be(16)      header size — where the data region starts
        u64be(n)       length of the data region
        <data>         the patcher JSON, then every inlined file end to end
        <directory>    the root record, then one `dire` record per file
```

The directory and each `dire` are chunk lists of their own, carrying `type` (a 4-char
kind — `JSON` for patchers, `TEXT` for `.js`, `svg`, …), `fnam` (NUL-padded name),
`sz32` and `of32`. The root record describes the patcher; `of32` is relative to the
start of the `ptch` payload, not to the data region.

**Two traps, both of which produce plausible-looking garbage rather than an obvious
failure.** The outer `.amxd` chunk lengths are u32 **little**-endian while everything
inside `mx@c` is **big**-endian; and an inner chunk's length **includes** its own
8-byte header where an outer one's does not. A parser that seems to half-work — right
first entry, nonsense after it — has one of these backwards.

Decoded by dissecting frozen devices in the User Library, and read-only: freezing is
Live's job, and `pack` only writes the unfrozen form. Verified against `Sting 3.amxd`
(25 inlined files, 11 of them `.js`) and `SQ Sequencer.amxd` (30).

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
