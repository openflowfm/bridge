# tools/

Build tooling. Not compiled — Node 26 runs `.ts` directly via type stripping, so
these execute straight from source.

```
amxd.ts                      pack / unpack / inspect .amxd containers  (library + CLI)
build-bridge.ts              bundles bridge.js — ws inlined
build-device.ts              generates the patcher and packs the device
lom-reference.ts             rescrapes the LOM page to a scratch file, for diffing
visuals.ts                   the visuals rig in a dedicated Chrome — npm run visuals:browser
build-electron.ts            bundles a module's Electron main, preload and server
build-icons.ts               makes an app's .icns from its own public/mark.svg
install-apps.ts              copies the packed apps into /Applications/open[flow]
install-device.ts            copies the device into the Ableton User Library, as -qa
coverage-summary.ts          coverage-summary.json as a build-page table and a shields badge
record-session.ts            records a real session off the bridge, as test corpus
mutate.ts                    breaks a file one edit at a time — would its spec notice?
version.ts                   sets one version across every package.json and lock
```

**`mutate.ts` imports `typescript-syntax`, not `typescript`.** TypeScript 7's package
is a launcher for a Go compiler and ships no JavaScript parser, so there is no AST to
walk. `typescript-syntax` is an npm alias pinned to `typescript@5.9.3` — the parser
this tool's mutant set was tuned against — and Dependabot is told to leave it alone.

```sh
npm run visuals             # a show night: the visual[flow] app
npm run set                 # the set[flow] app
npm run qa                  # build + pack + install:apps — everything, onto this machine
npm run pack                # every app as .app and .dmg under release/
npm run install:apps        # copies those into /Applications/open[flow] — or one: install:apps set
npm run install:device      # the device into the User Library as SessionBridge-qa
npm run dev:set             # just set[flow]: its dev server and its window — dev:visuals, dev:mix too
npm run dev:set-app         # the set[flow] shell alone, on a dev server already up
npm run dev:visuals-app     # visual[flow]'s HMR shell + backend; npm run dev launches it
npm run app -- <cmd> [app…] # build | electron | icons | pack | run | dev — see below
npm run visuals:browser     # the visuals rig in a dedicated Chrome — see below
npm run build:bridge        # writes bridge/bridge.js (bundled) and bridge/lom.js
npm run build:device        # writes bridge/SessionBridge.{amxd,maxpat}
npm run dev:lom-scrape      # writes node_modules/.cache/lom-scraped.md
npm run dev:record -- <name> [seconds]   # a real session into set/test/corpus/<name>/
npm run dev:mutate -- <source file>      # mutation score for its colocated spec
npm run dev:version -- <version>         # 0.2.0-dev, 0.2.0-rc.1, 0.2.0 — then commit
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

## The desktop apps

`app.ts` is the driver, and every per-app script is a one-line alias onto it:

```sh
npm run app -- build [app…]      # the renderer, with vite
npm run app -- electron [app…]   # main, preload, and a server if it has one
npm run app -- icons [app…]      # the .icns, from that app's own mark
npm run app -- pack [app…]       # all three, then electron-builder
npm run app -- run <app>         # build, electron, and open it
npm run app -- watch <app>       # its dev server and its window, together
npm run app -- dev <app>         # electron, and open it against a running dev server
```

With no app named, everything but `run` and `dev` does all of them — which is why
`npm run pack` and the CI build step need no editing when an app is added. Which apps
there *are* is `desktop/src/apps.ts`, and so are their names, their dev-server offsets
and their backend ports;
[`desktop/docs/registry.md`](../desktop/docs/registry.md) is the doc for adding one.

`watch` is the one to type while working. `-k` is what makes it one command rather than
two in a trench coat: closing the window takes vite with it, and a vite that cannot bind
takes the window's retry loop with it rather than leaving it asking forever. `npm run dev`
is the other arrangement — every server in the repo at once, and `dev:<app>-app` to attach
a window to one of them.

There used to be five npm scripts per app, and `pack:set` was a two-hundred-character line
that differed from `pack:visuals` in one word. That is the thing this replaced: a third app
meant five more, written by copying, which is how the QA overrides in one of them stop
matching the other. Anything that looks like a flag is still forwarded to electron-builder,
so `npm run pack:set -- -c.mac.identity="…"` works as it did.

Where the reasoning lives: [`desktop/README.md`](../desktop/README.md) for everything the
apps share, [`set/docs/desktop.md`](../set/docs/desktop.md) for the custom scheme and where
state goes, [`visuals/docs/desktop.md`](../visuals/docs/desktop.md) for the supervised
server, the wall window and the display list.

`build-electron.ts` esbuilds `<module>/electron/{main,preload}.ts` to **CommonJS**. Both
halves are forced: Electron's bundled Node does not strip types the way Node 26 on your PATH
does, and a `sandbox: true` preload must be CJS. It also bundles a module's own server — if
the registry says it has one — and that to **ESM**, because the server reads
`import.meta.url` to find its renderer and its Link addon, both empty in a CJS bundle.

`npm run pack` makes real `.app` bundles with `electron-builder` from a config shared by
every app, and `npm run install:apps` copies them into `/Applications/open[flow]` — a
separate step because packing writes a build artifact and installing is a decision about the
machine. They go in a folder of their own so the suite arrives as one thing rather than as
three unrelated icons, and an install sweeps away the loose copy an earlier one left in
`/Applications` itself. It replaces rather than merges, refuses to overwrite an app that is
open, and takes `OPENFLOW_APPS` if `/Applications` is not yours to write. Neither building nor packing is
part of `npm run build` — that script is what CI enforces and what produces the `.amxd`, and
it has no business needing an Electron binary.

**`npm run qa` is those four in order** — the device, every app, and all three installed
where the machine looks for them — for when the next thing you do is drive the real thing
rather than a dev server. It stops at the first failure, so a bad build never reaches
`/Applications/open[flow]`. It is also the only thing that sets `OPENFLOW_QA=1`, which is what makes
the device stamp itself with the commit it came from — see *QA builds say so* below. It runs neither `typecheck` nor `test`: those are fast and belong in the
loop before this one, and a script that quietly reruns them makes the slow path look like
the cheap one. The chart is not in it either — it is a page, not an app, and
`npm run build:chart` stands alone.

`install-device.ts` writes a **folder**, `SessionBridge-qa/`, not three loose files. The
device is `[node.script bridge.js]` and `[v8 lom.js]`, which Max resolves by name from the
patcher's own folder, so two devices sharing a folder share one pair of scripts — a `-qa`
suffix on the `.amxd` alone would overwrite the scripts an installed device runs. The suffix
names it in Live; the folder is what keeps the two apart. `OPENFLOW_USER_LIBRARY` points at
the `Max for Live` folder when the User Library has been moved.

Freezing would make this one file instead of three, and is deliberately not done here:
`amxd.ts` reads the `mx@c` archive a frozen device carries but never writes it, because
freezing is Live's own operation. A frozen device also has nothing for `@watch 1` to watch.

## `npm run visuals:browser`

The visuals rig in a dedicated Chrome instead of the app. Kept because a second machine runs
a browser anyway — which is the arrangement the rig was always meant for — and because it is
the rollback if the app misbehaves on a show night.

`npm run dev` is `concurrently -k` over ten dev processes, including the visual[flow]
Electron app on vite's HMR page, and `-k` means **any one of them exiting kills all the
others** — right for a dev loop, and wrong for a gig, where a chart server or a
`tsc --watch` falling over would take the wall down with it. In that stack the app owns and
supervises its backend. `visuals.ts`, the show-browser alternative, builds `visuals/dist`
and runs `visuals/server/index.ts` itself, restarting it after a second if it stops.

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
either way, though the shader-portability argument this used to make was wrong — Safari and
Chrome both reach the GPU through ANGLE onto Metal. What rules it out is that its macOS
webview is WKWebView and `visuals/` draws its show *inside* the webview, so the switches
below would have no equivalent. See `visuals/docs/engine.md`.

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

### QA builds say so, and say which one

`OPENFLOW_QA=1` marks a build as one made to be driven rather than shipped. `npm run qa`
sets it and nothing else does, so a release build is untouched by all of this.

It changes three display strings and no identity:

- The footer reads `open[flow] 0.1.0 · qa a1b2c3d` — `git rev-parse --short HEAD`, with a
  trailing `*` when the tree had uncommitted changes. **That mark is the point rather than
  a detail**: building from a dirty tree is the normal way a QA build gets made, and a bare
  hash would be claiming a commit that doesn't contain what's running. This is the only
  place the *running* device says which build it is — "is Live holding the thing I just
  built, or the copy it cached three reloads ago?" has no other answer from inside Live.
- `digest` becomes `Session Bridge (QA)`, which is what Live draws in the browser and the
  Info View, and the description picks up the same hash.
- The patching-view header follows `digest`, for when the `.maxpat` is open in Max.

**The device's name is not one of them, and must not be.** Live takes the name from the
`.amxd` filename and a saved set refers to the device by it; `digest` is a separate,
display-only field, which is what lets a QA build announce itself without any set going
looking for a device that no longer exists. The `-qa` on the filename is
`install-device.ts`'s doing and belongs to the installed *copy* — see above. The two
parameter long names, `openflow-state` and `Song`, are identities too and never move.

### Patch topology

```
[live.thisdevice] ─> [initialized latch] ─> [init( ─> [s ---openflow-to-lom]
[node.script] out0 ──────────────────────-> [s ---openflow-to-lom]

[r ---openflow-to-lom] ─> [route clients device_state_get device_state_set]
                       ├─ clients ─────> [unpack 0 0 0 0 0]
                       │        ready ──> [sel 0 1] ─> set "Waiting for Live" / "Connected
                       │                                to Live"        ─> status text
                       │        set ────> [sel 0 1] ─> bgfillcolor …    ─> set[flow] dot
                       │        visual ─> [sel 0 1] ─> bgfillcolor …    ─> visual[flow] dot
                       │        chart ──> [sel 0 1] ─> bgfillcolor …    ─> chart[flow] dot
                       │        extra ──> [sel 0] ──┬─ set " "
                       │                            └─ [sprintf set plus %ld more( ─> line
                       ├─ state get/set > [pattr openflow-state]
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
- **The route peels off the face as well as device state.** State travels directly
  between Node and the parameter-enabled pattr; it is not part of the Live Object Model.
- **The face is five integers on the wire, spelled here.** Node sends `clients <ready>
  <set> <visual> <chart> <extra>` and the patch turns it into words and colours. Keeping
  every string a user reads in the file that draws them is half the reason; the other
  half is that a bare integer has no quoting to get wrong, where `set[flow]` is a symbol
  with brackets in it that would have to survive Node for Max, the outlet, a `route` and
  an `unpack` unchanged. **Adding an app means adding a row here and a name to
  `OpenFlow.ClientKind`** — nothing else reads the wire message.
- **`unpack`, not five messages.** The five are one state, and sent separately a roster
  mid-update would draw a moment of a set that was never true. `unpack` fires right to
  left off one list, so the whole face moves at once.
- **A dot is a `panel` with `shape: 1`, saved as `bgcolor` and recoloured by
  `bgfillcolor` messages.** That's the same split the display panel makes: `bgcolor` is
  the cached literal a patch loads with, `bgfillcolor` is what a panel fills from and
  what a message can move. Neither factory device this was dissected from saves a literal
  `bgfillcolor`, so nothing here writes one. Both colours are literals rather than theme
  names, for the same reason `lcdText` exists: the display panel stays dark in Live's
  light theme, so a surface colour would be black on near-black. The lit colour is that
  app's own mark hue — the middle stop of the gradient in `<app>/public/mark.svg`, which
  is the hue the Dock reads at 32px.
- **`sel 0 1` has one inlet; `sel 0` has two.** `select` only grows a right inlet to set
  its match value when it has a single argument. Declaring one on the latter wouldn't
  remove it, only make the patch lie about its own shape.
- **The `plus n more` line uses `set " "` to clear, and carries no `+`.** Max's own
  reference gives `set` a required argument, so a bare `set` may or may not empty a
  comment — and a line that may or may not have cleared goes on naming a client that
  left. `sprintf` emits a *string* Max reparses into atoms, and whether `+1` survives
  that as a symbol or arrives as the number 1 is not something the reference settles.
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
