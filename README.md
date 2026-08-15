# bridge/

The Max for Live device. Two halves in one folder, because they run in two
completely different JavaScript environments.

```
                    ┌─────────────────────────────────────┐
  browser ──WS/JSON─┤ bridge.js   (Node for Max)          │
                    │   HTTP + WebSocket, serves the UI   │
                    │   knows nothing about Live          │
                    └──────────────┬──────────────────────┘
                                   │ Max messages + Dicts
                    ┌──────────────▼──────────────────────┐
                    │ lom.js      (Max [v8])              │
                    │   every LiveAPI call in the project │
                    └──────────────┬──────────────────────┘
                                   │ Live Object Model
                              Ableton Live
```

| source | emits | runtime |
|---|---|---|
| `src/bridge.ts` | `bridge.js` | Node 22 inside Node for Max, CommonJS |
| `src/lom.ts` | `lom.js` | Max's `[v8]` object — no module system at all |
| `types/max.d.ts` | — | ambient `LiveAPI` / `Dict` / `Task` / globals |
| `types/max-api.d.ts` | — | ambient `max-api` module |

`bridge/package.json` exists solely so `ws` installs into `bridge/node_modules`
for the dev loop. **Nothing ships from there** — see below.

## Where the reasoning lives

Each area has one doc under [`docs/`](docs/). **Read the row you need, not the set.**
More constraints live in this module than anywhere else in the project, and most of them
are non-obvious.

| doc | read it before touching | source |
|---|---|---|
| [LOM gotchas](docs/lom-gotchas.md) | **`lom.ts`, at all.** Start here | `src/lom.ts`, [`LOM.md`](LOM.md) |
| [message protocol](docs/message-protocol.md) | anything crossing Node ↔ `[v8]` — atoms, Dicts, errors | `src/bridge.ts`, `src/lom.ts`, [`protocol/`](../protocol/README.md) |
| [following Live](docs/following-live.md) | the cursor observers, deltas, or what a re-read publishes — including into the set the bridge holds | `src/lom.ts`, `core/src/snapshotDelta.ts` |
| [reordering scenes](docs/reordering-scenes.md) | **the one write that can damage a set** — the four passes and their guards | `src/lom.ts`, `core/src/sceneMove.ts` |
| [multiple clients](docs/multiple-clients.md) | **the set the bridge holds and serves without a walk**, broadcast, or anything assuming one UI | `src/bridge.ts`, `core/src/setModel.ts` |
| [device state and palette](docs/device-state.md) | set-owned configuration, the hidden parameter, the color table | `src/bridge.ts`, `src/lom.ts`, `core/src/livePalette.ts` |
| [build and load](docs/build-and-load.md) | the compile targets, what ships, loading the device in Live | `tsconfig.node.json`, `tsconfig.v8.json`, `tools/build-bridge.ts` |
| [diagnostics](docs/diagnostics.md) | the diagnostic surfaces, snapshot phases, or what's testable without Live | `src/bridge.ts`, `tools/diag.ts` |

[`LOM.md`](LOM.md) is the Live Object Model reference itself — every class, property and
function with its type and access mode, plus where Cycling '74's docs are wrong about the
version we run. **Look things up there; don't guess**, and don't assume a property you can
read is one you can write.
