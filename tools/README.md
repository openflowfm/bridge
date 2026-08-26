# tools/

Build tooling. Not compiled — Node 24 runs `.ts` directly via type stripping, so
these execute straight from source.

```
amxd.ts                      pack / unpack / inspect .amxd containers  (library + CLI)
build-bridge.ts              bundles bridge.js — ws inlined
build-device.ts              generates the patcher and packs the device
lom-reference.ts             rescrapes the LOM page to a scratch file, for diffing
visuals.ts                   the visuals rig in a dedicated Chrome — npm run visuals:browser
build-electron.ts            bundles a module's Electron main, preload and server
build-icons.ts               makes an app's .icns from the mark and one colour
```

```sh
npm run visuals             # a show night: the visual[flow] app
npm run set                 # the set[flow] app
npm run pack                # both apps as .app and .dmg under release/
npm run visuals:browser     # the visuals rig in a dedicated Chrome — see below
npm run build:bridge        # writes bridge/bridge.js (bundled) and bridge/lom.js
npm run build:device        # writes bridge/SessionBridge.{amxd,maxpat}
npm run dev:lom-scrape      # writes node_modules/.cache/lom-scraped.md
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

## Two desktop apps

`npm run set` and `npm run visuals` each build their renderer, build their Electron shell
with `build-electron.ts`, and launch it. Where the reasoning lives:
[`set/docs/desktop.md`](../set/docs/desktop.md) for the custom scheme and where state goes,
[`visuals/docs/desktop.md`](../visuals/docs/desktop.md) for the supervised server, the wall
window and the display list.

`build-electron.ts` esbuilds `<module>/electron/{main,preload}.ts` to **CommonJS**. Both
halves are forced: Electron's bundled Node does not strip types the way Node 24 on your PATH
does, and a `sandbox: true` preload must be CJS. It also bundles visual[flow]'s server, and
that one to **ESM**, because the server reads `import.meta.url` to find its renderer and its
Link addon — both empty in a CJS bundle.

`npm run pack` makes real `.app` bundles with `electron-builder`, unsigned for now. Neither
building nor packing is part of `npm run build` — that script is what CI enforces and what
produces the `.amxd`, and it has no business needing an Electron binary.

## `npm run visuals:browser`

The visuals rig in a dedicated Chrome instead of the app. Kept because a second machine runs
a browser anyway — which is the arrangement the rig was always meant for — and because it is
the rollback if the app misbehaves on a show night.

`npm run dev` is `concurrently -k` over ten dev processes, and `-k` means **any one of them
exiting kills all the others** — right for a dev loop, and wrong for a gig, where a chart
server or a `tsc --watch` falling over would take the wall down with it. `visuals.ts` builds
`visuals/dist` and then runs `visuals/server/index.ts` alone, restarting it after a second
if it stops.

Two exits it does **not** restart, because neither is fixed by trying again: a clean one,
which is the server's own Ctrl-C path, and status **2**, which is the port already being
taken. That code exists for this — the server has already printed which port and how to
find what is on it, and a supervisor relaunching into the same message once a second is
noise on top of a problem.

### It opens a browser that belongs to the show

Once the port answers, it opens the rig in **its own Chrome** — macOS only, `--no-browse`
to skip it, and skipped anyway if one is already up on that profile.

The lever is `--user-data-dir=~/.openflow/visuals/chrome`, which makes it a separate
*instance* rather than a flag on the browser you read your mail in: no extensions, no forty
other tabs on the same GPU, its own share of the ~16 WebGL contexts a browser keeps per
origin, and its own permissions — so the window-management grant the wall needs is given
once and stays given, rather than being asked for on a stage. `--app=` drops the tab strip
and the address bar.

It is the lightest Chromium available on a Mac, because it is the Chromium already
installed — and that argument is why this path existed before there was an app, and why it
is still here now.

**What changed is the question, not the answer.** While the device served the session
manager there was a URL to point a browser at, so "Chrome or Electron" was a real choice and
Chrome won it. The device serves nothing now, so the choice is "ship a window or ship a
server", and only one of those leaves the device carrying nothing. Tauri was not an option
either way: its macOS webview is WKWebView rather than Chromium, and every shader in
`visuals/` has been validated against one engine.

Three of the flags are about a projector specifically:

```
--disable-background-timer-throttling
--disable-backgrounding-occluded-windows
--disable-renderer-backgrounding
```

Chrome slows and eventually freezes a renderer it decides nobody is looking at, and a wall
window sitting behind the console is exactly that. Without these, bringing another window to
the front can drop the projector to a stutter.

**The app needs the same three**, because Electron is the same Chromium — it passes them as
command-line switches and sets `backgroundThrottling: false` on every window besides. This
is the easiest thing in either path to forget, and the symptom reads as a renderer bug.

**Only for a server it started.** The readiness poll waits a beat before its first look,
because a port already in use answers *immediately* — from whatever is on it — and a window
would open onto somebody else's server a moment before ours died of `EADDRINUSE`. The
settle gives that failure time to land, and the child going away is what says it did.

## The LOM reference

`lom-reference.ts` scrapes Cycling '74's LOM page into
`node_modules/.cache/lom-scraped.md`. Run it after a Live upgrade, then diff it against
[`bridge/LOM.md`](../bridge/LOM.md) and merge what changed. The download is cached in
`node_modules/.cache/lom.html`; delete that to refetch.

**It does not write `bridge/LOM.md`, and must not be changed to.** That file was
generated once and has been hand-maintained since — it carries the observer-write
prohibition, the session-ring dead end and the mixer paths this app uses, none of which
are on the page. Regenerating over it deleted 126 lines of that in a single command,
which is why the output goes to a scratch path now and a human does the merge.

Three things about it are deliberate:

- **It parses the page's `liveapi_*` class names, not flattened text.** Once the tags
  are gone a function name and one of its parameter names are the same shape, and a
  text parser reads `create_scene`'s `index` argument as a sibling function. The first
  version did exactly that and invented four `Song` methods.
- **It asserts its own output.** The page declares how many children, properties and
  functions it contains via those same class names, so the parser counts them and
  throws if the emitted total disagrees. A reference that silently drops members is
  worse than no reference, because you'd trust it.
- **A description runs to the next structural boundary, not to the first `</p>`.**
  Where a description continues into a bulleted list the page emits `…</p><ul><li>…` —
  the list is a *sibling* that closes the paragraph — so bounding on `</p>` drops every
  bullet. That silently cost `add_warp_marker` all three of its constraints, including
  the `[5, 999]` BPM limit on the resulting segments. `<li>` renders as `• ` so the list
  survives being flattened into a table cell.

The page is pinned to **Live 12.1** and we run 12.4.3, so it is not the last word.
`LOM.md` records what Live's own binary adds and contradicts; the recipe for checking a
single name against the installed version is in there too.

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
[live.thisdevice] ─> [initialized latch] ─> [init( ─> [s ---openflow-to-lom]
[node.script] out0 ──────────────────────-> [s ---openflow-to-lom]

[r ---openflow-to-lom] ─> [route status device_state_get device_state_set]
                       ├─ status ──────> [sel -1 0 1] ─┬─ set "Waiting for Live"
                       │                               ├─ set "No connections"
                       │                               ├─ set "1 connection"
                       │                               └─ [sprintf set %ld connections(
                       ├─ state get/set > [pattr openflow-state]    └─> status text
                       └─ rest ────────> [deferlow] ─> [v8 lom.js]
[pattr openflow-state] ─> [prepend device_state] ─> [s ---openflow-to-node]
[v8 lom.js] ─> [route boot] ─┬─ rest ──────────────> [s ---openflow-to-node]
                             └─ boot + initialized ─> [init(

[r ---openflow-to-node] ─> [node.script] in0

[live.text] ─> [; max launchbrowser …(                   two of these: app, GitHub

[plugin~] ─> [plugout~]                                  audio passthrough
```

Notes that matter if you edit this:

- **`send`/`receive` break the request/response cycle.** Wiring `node.script` and `v8`
  directly to each other would be a graph loop.
- **`deferlow` on the way into `v8`** gets LOM work off the incoming message's call
  stack.
- **`live.thisdevice` fires `init`** — LiveAPI is unsafe before the device is fully
  loaded.
- **The patcher remembers that initialization outside `lom.js`.** Autowatch recompiles
  reset every script global, including `deviceReady`, without reloading the device or
  retriggering `live.thisdevice`. On script load `lom.js` emits a private `boot`; once
  the patcher latch says `live.thisdevice` has completed, that signal replays `init`.
  Before the first completion the signal is ignored, preserving the LiveAPI safety gate.
- **The route peels off device state as well as status.** State travels directly
  between Node and the parameter-enabled pattr; it is not part of the Live Object Model.
- **The Status line is one integer on the wire, spelled here.** Node sends the number
  of connected clients — or `-1` while the LOM handshake is still outstanding — and the
  patch turns it into words. Keeping every string a user reads in the file that draws
  them is half the reason; the other half is that a bare integer has no quoting to get
  wrong, where a symbol with a space in it does. `select` gets the two counts that don't
  pluralize and `sprintf` gets the rest; note `sel -1 0 1` has **one** inlet, because
  `select` only grows a second one when it has a single argument to set through it.
- **`pattr openflow-state` is a Blob parameter registered in the patcher's `parameters`
  map.** Both pieces are required for Live to store the base64url-encoded JSON in the
  `.als`. It is marked Stored Only so it cannot be automated.
- **`plugin~` and `plugout~` are both 2-in/2-out `signal`**, copied verbatim from
  Live's own template. Getting these wrong breaks the audio path.
- **Presentation view is the only thing Live shows.** `openinpresentation: 1`, and each
  visible box needs `presentation: 1` plus `presentation_rect`. Everything else is
  hidden.
- **The face is 244 × 169.** Live fixes device height at 169px — every factory Max
  device it ships is laid out in exactly that box — so anything positioned below it is
  simply not drawn, with no warning. The patcher `rect` is saved at the device size for
  the same reason Ableton's are: opening the `.maxpat` then shows you what Live shows.
- **`live.text` needs `mode: 0`** (Button). The default is `1` (Toggle), which would
  make the launch button a stateful thing that reports 1 and 0 on alternate clicks.
- **In Button mode `live.text` bangs; it does not send `1`.** Max's own reference:
  "In button mode, a mouse click … send[s] the text out the second outlet and a bang
  message out the left outlet." Only Toggle mode sends `1`. The button spent a while
  wired through a `sel 1`, which a bang never matches, so clicking it did nothing at
  all — no error anywhere, because nothing was wrong, it just never fired. It also
  has **two** outlets whatever `numoutlets` claims; the right one carries the label.
- The buttons send `; max launchbrowser <url>` — the app, and the GitHub project page.

### Making it look like a stock device

Ableton's factory Max devices are unprotected in the Factory Packs (`Step Arp`,
`SQ Sequencer`, `Rhythmic Steps`), so `node tools/amxd.ts unpack` on one of those is the
reference for anything visual. What they do that a hand-built patch doesn't:

- **Colors are bound to Live's theme by name, not frozen.** A color attribute is saved
  as a literal *plus* an expression:
  `"saved_attribute_attributes": { "textcolor": { "expression": "themecolor.live_lcd_title" } }`.
  Live redraws from the expression when the user's theme changes; the literal is only a
  cached fallback. The full list of names is in
  `Max.app/Contents/Resources/C74/interfaces/maxcolors.json` — the 72 ids starting
  `live_`.
- **Text on a display panel cannot be a `live.comment`.** `live.comment` draws in the
  *surface* text color, which is black in Live's light theme, while `live_lcd_bg` stays
  dark in both. Ableton uses a plain `comment` bound to the `live_lcd_*` family for
  anything over a display, and `live.comment` only for text sitting on the surface.
  Getting this backwards looks fine until someone switches theme.
- **Plain `comment` needs the font set explicitly** — `"fontname": "Ableton Sans Medium"`,
  `fontsize` 9.5 for labels. It's the patcher font otherwise, which is what makes a
  hand-built device read as a Max patch. `live.*` objects already draw in Live's font.
  Both stock Max and the Max inside Live ship the family, so the `.maxpat` looks right
  open on its own too.
- **Labels are Title Case**, not caps and not lowercase: `Status`, `Address`, `Octaves`,
  `Key Retrig.`.
- **Don't repeat the device's name inside it.** Live already draws it in the title bar.
- **`live.line` is the separator** and `panel` is the display background — `background: 1`
  so it stays behind the text, `rounded: 4`, and the fill expression goes on
  `bgfillcolor` while the cached literal sits on `bgcolor`.
- **Every control carries an `annotation`**, which is what Live's Info View reads out on
  hover. A device that leaves that panel blank announces that it isn't a stock one.

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

### Checking the embedded Live palette

With Live open and Session Bridge connected, run:

```sh
npm run dev:check-palette
```

The script invokes the developer-only LOM sweep, compares every returned RGB value with
`core/src/livePalette.ts`, and prints the current table if it differs. It creates and
removes one scratch MIDI track, so this is an explicit release-maintenance check rather
than app startup behavior.
