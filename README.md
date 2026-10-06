# SessionBridge

The Max for Live device of **open[flow]**: it holds the current state of a Live set and
serves it to every client — [set[flow]](https://github.com/openflowfm/set),
[visual[flow]](https://github.com/openflowfm/visuals),
[chart[flow]](https://github.com/openflowfm/chart),
[master[flow]](https://github.com/openflowfm/master) — over WebSocket on port 17800. It is
the one job that has to happen inside Max; every interface is an app of its own.

```
set[flow]    ──WS/JSON──┐
                        ├──> node.script (bridge.js) ──Max msgs──> v8 (lom.js) ──> Live
visual[flow] ──WS/JSON──┤         :17800, WS only        the only LOM code
   └─ its own server ───┤               ▲
chart[flow]  ──WS/JSON──┤               │ global Max sends
master[flow] ──WS/JSON──┘      OpenFlowProbe.amxd × n
```

chart[flow] is read-only, and the only one that binds the LAN.

master[flow] also uses a second, much smaller device: **`OpenFlowProbe.amxd`**, built from
`probe/`. A probe sits in a chain and measures the signal there; it talks only to the
bridge, over global Max sends, and the bridge serves its numbers to clients — see
[message protocol](docs/message-protocol.md#probe-devices--bridge).

The device is the WebSocket server and nothing else. It ships as an `.amxd` plus two JS
files — no app bundle, no code signing, no updater. The logic it runs on is
[`@openflow/core`](https://github.com/openflowfm/core), the wire types are
[`@openflow/protocol`](https://github.com/openflowfm/protocol), and both are bundled in.

Two halves in one repo, because they run in two completely different JavaScript
environments.

```
                    ┌─────────────────────────────────────┐
  browser ──WS/JSON─┤ bridge.js   (Node for Max)          │
                    │   the WebSocket server              │
                    │   holds the set + the song mapping  │
                    │   makes no LiveAPI call itself      │
                    └──────────────┬──────────────────────┘
                                   │ Max messages + Dicts
                    ┌──────────────▼──────────────────────┐
                    │ lom.js      (Max [v8])              │
                    │   every LiveAPI call in the project │
                    └──────────────┬──────────────────────┘
                                   │ Live Object Model
                              Ableton Live
```

**`bridge.js` is where the current state of the set lives.** It reads the set once when
the LOM is ready, watches Live's structure and Session cursor for as long as the device is
loaded, patches what it holds from every delta and every write, and derives the song
mapping from it. A browser asking for the set gets a payload, not a walk — and a browser
opening, closing or reloading changes none of it. That invariant is rule 5, and the
reasoning is under [multiple clients](docs/multiple-clients.md).

It still makes no LiveAPI call of its own; that distinction is what rule 2 is about, and
it is not the same claim as knowing nothing about Live.

| source | emits | runtime |
|---|---|---|
| `src/bridge.ts` | `bridge.js` | Node 22 inside Node for Max, CommonJS |
| `src/lom.ts` | `lom.js` | Max's `[v8]` object — no module system at all |
| `types/max.d.ts` | — | ambient `LiveAPI` / `Dict` / `Task` / globals |
| `types/max-api.d.ts` | — | ambient `max-api` module |

`ws` is the only runtime dependency, and it is inlined into `bridge.js` at build time.
**Nothing ships from `node_modules/`** — see [build and load](docs/build-and-load.md).

## Installing the device

Everything is on the [latest release](../../releases/latest).

1. Unzip `SessionBridge-<version>.zip` somewhere permanent, and keep
   `SessionBridge.amxd`, `bridge.js` and `lom.js` together. The device loads the two
   JavaScript files from beside itself, so a lone `.amxd` is broken.
2. Drag `SessionBridge.amxd` onto any track. It's an inert audio passthrough, so the Master
   track is fine.
3. Wait for the device to read **Connected to Live**.
4. Launch an app. It finds the device by itself and appears on the device face: every
   app that identifies itself gets a row, in the order it first connected, and its dot
   lights while it's attached. A closed app's row dims rather than disappearing; past
   four apps, the rest show as "plus n more".

Only one copy of the device can run at a time — two would fight over the port. The
server binds `127.0.0.1` only, and nothing is downloaded at runtime.

The longer version is [Installing](https://github.com/ryangavin/better-session-view/wiki/Installing)
in the user manual.

## Building it

```sh
git clone https://github.com/openflowfm/bridge.git
cd bridge
npm ci
npm run build          # bridge.js, lom.js and SessionBridge.amxd, in the repo root
npm run qa             # the same, then installed into the User Library as SessionBridge-qa
npm run dev            # the three watchers — bridge.js, its types, and lom.js
```

| script | does |
|---|---|
| `npm run build` | a bundled `bridge.js`, `lom.js`, and the device |
| `npm run build:device` | the `.amxd` only — deliberately not watched |
| `npm run install:device` | the device into the Ableton User Library, as `SessionBridge-qa` |
| `npm run build:probe` | `OpenFlowProbe.amxd`, the probe device, from `probe/` |
| `npm run install:probe` | the probe device into the Ableton User Library |
| `npm run qa` | build and install at once, ready to try; marks the build as QA on the device face |
| `npm run dev` | the watchers. Point Live at the `-qa` copy and reload the device to pick up a change |
| `npm run typecheck` | both halves, `tools/` and `probe/` (skipped while `probe/` is absent) |
| `npm test` | the probe's analysis tests in `probe/test` (skipped while absent) |
| `npm run diag -- <what>` | one diagnostic message to a running device — [diagnostics](docs/diagnostics.md) |
| `npm run check-palette` | Live's palette against `@openflow/core`'s table |
| `npm run lom-scrape` | rescrape the LOM docs to a scratch file, for diffing against `LOM.md` |
| `npm version <v> --no-git-tag-version` | the version on the device face; the release guard refuses a tag that disagrees |

The only unit tests here are the probe's (`npm test`). `bridge.ts` reaches its logic
through `@openflow/core`, which is where its tests are; `lom.ts` needs Live open with the device loaded and has no
automated coverage at all. CI attaches every build so a change can be tried in Live
without building the branch by hand.

### Environment this was built against

Nothing here is version-agnostic; the device depends on what Live's embedded Max provides.

| | |
|---|---|
| Ableton Live | 12.4.3 Suite |
| Max embedded in Live | 9.1.4 — supplies `v8` and Node for Max |
| Node inside Node for Max | 22.18 (bundled with Max) |
| Node for tooling | 26 — runs `.ts` directly via type stripping |

## Where the reasoning lives

Each area has one doc under [`docs/`](docs/). **Read the row you need, not the set.**
More constraints live in this module than anywhere else in the project, and most of them
are non-obvious.

| doc | read it before touching | source |
|---|---|---|
| [LOM gotchas](docs/lom-gotchas.md) | **`lom.ts`, at all.** Start here | `src/lom.ts`, [`LOM.md`](LOM.md) |
| [message protocol](docs/message-protocol.md) | anything crossing Node ↔ `[v8]` — atoms, Dicts, errors — or reaching the device face or a probe device | `src/bridge.ts`, `src/lom.ts`, `tools/build-device.ts`, `probe/`, [`@openflow/protocol`](https://github.com/openflowfm/protocol#readme) |
| [following Live](docs/following-live.md) | the cursor observers, deltas, or what a re-read publishes — including into the set the bridge holds | `src/lom.ts`, core's `snapshotDelta.ts` |
| [reordering scenes](docs/reordering-scenes.md) | **the writes that can damage a set** — `move`'s four passes and their guards, and `keepScenes` ("new show"), which deletes every scene not kept | `src/bridge.ts`, `src/lom.ts`, core's `sceneMove.ts` |
| [multiple clients](docs/multiple-clients.md) | **the set the bridge holds and serves without a walk**, broadcast, the roster on the device face, probe passes, or anything assuming one UI | `src/bridge.ts`, core's `setModel.ts` |
| [device state and palette](docs/device-state.md) | set-owned configuration, the hidden parameter, the color table | `src/bridge.ts`, `src/lom.ts`, core's `livePalette.ts` |
| [build and load](docs/build-and-load.md) | the compile targets, what ships, loading the device in Live | `tsconfig.node.json`, `tsconfig.v8.json`, `tools/build-bridge.ts` |
| [diagnostics](docs/diagnostics.md) | the diagnostic surfaces, snapshot phases, or what's testable without Live | `src/bridge.ts`, `tools/diag.ts` |

[`LOM.md`](LOM.md) is the Live Object Model reference itself — every class, property and
function with its type and access mode, plus where Cycling '74's docs are wrong about the
version we run. **Look things up there; don't guess**, and don't assume a property you can
read is one you can write.

[`tools/README.md`](tools/README.md) covers the `.amxd` container format, the device
generator and the LOM scrape. [`AGENTS.md`](AGENTS.md) is the startup read for anyone —
person or agent — changing this code.
