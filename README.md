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

`bridge/package.json` exists solely so `ws` installs into `bridge/node_modules`.
Keeping it local (rather than hoisted to the root) is what lets the folder stay
self-contained for the device.

## Loading it in Live

1. Drop `SessionBridge.amxd` onto any track. It's an audio effect with a
   `plugin~ → plugout~` passthrough, so it's inert on the signal path — the Master
   track is a fine home.
2. Wait for the status line to read `connected to Live`, then click **Open Session
   Manager**.

| status | means |
|---|---|
| `starting…` | patcher loaded, Node hasn't booted |
| `server up` | Node is listening, LOM handshake hasn't completed |
| `connected to Live` | both halves talking |

Stuck on either of the first two? **Options ▸ Max ▸ Open Max Window** — that's where
every error and every timing line lands.

**Keep the folder together.** The device resolves `bridge.js` and `lom.js` relative
to its own location, so load the `.amxd` from this repo rather than copying it into
the User Library alone.

Only one copy of the device can run at a time — they'd fight over port 17800. A
second instance posts a warning rather than crashing. `BSV_PORT` overrides.

After a rebuild Live usually reloads the device on its own. If behaviour looks stale,
delete it from the track and re-drag.

## Why the two compile targets differ

This is the part that surprises people, and it's all forced by Max.

**`lom.ts` compiles with `module: "none"` and `alwaysStrict: false`.**

- Max's `[v8]` discovers message handlers as **top-level global function
  declarations**. A message `snapshot 7` calls `function snapshot(reqId)`. Any module
  wrapper — ESM, CJS, IIFE — hides them and nothing works.
- `autowatch`, `inlets`, `outlets` are pre-existing globals the script assigns to.
  `strict: true` injects `"use strict"`, which puts those assignments at risk. The
  hand-written predecessor ran without it, so we keep it that way.
- Consequence: **`lom.ts` cannot `import` anything.** That's why the protocol lives in
  a global `BSV` namespace rather than a module, and why atom-parsing logic is
  duplicated into `core/src/lomAtoms.ts` so it can be unit-tested.

**`bridge.ts` compiles to CommonJS**, because Node for Max injects `max-api` as a CJS
module and runs the emitted file directly.

Both emit into `bridge/` with `rootDir: "src"`. That's also why `bridge.ts` uses the
global `BSV` namespace instead of importing `protocol/` — an import would pull a file
outside `rootDir` and trip TS6059.

Compiling into this folder *improves* the dev loop: `node.script @watch 1` and
`autowatch = 1` watch the emitted `.js`, so a reload only fires on a successful
compile.

## Message protocol between the halves

Not the WebSocket protocol — see [`../protocol/README.md`](../protocol/README.md) for
that. This is Max messages between `bridge.js` and `lom.js`.

```
bridge.js  ──[s ---bsv-to-lom]──>  lom.js
lom.js     ──[s ---bsv-to-node]──> bridge.js
```

| → lom | |
|---|---|
| `init` | from `live.thisdevice`; LiveAPI is unsafe before this |
| `hello` | handshake; whichever side boots last drives it |
| `snapshot <reqId>` | walk the set |
| `apply <reqId> <dictName>` | execute an op batch |
| `palette <reqId>` | derive Live's color palette |
| `ping` | |

| → node | |
|---|---|
| `ready` | LOM side is live |
| `snapshot_done <reqId> <dict> <dictMs>` | |
| `apply_progress <reqId> <done> <total>` | |
| `apply_done <reqId> <dict> <ms>` | |
| `palette_done <reqId> <dict>` | |
| `changed <kind>` | observer fired |
| `err <reqId> <msg>` | |

`serving` also travels node → lom's direction but is routed off by `[route serving]`
before reaching `v8`; it only drives the device's status line.

### Large payloads go through Dicts, never message atoms

Clip names contain spaces, commas and semicolons — all special in Max messages.
Anything bigger than a few numbers crosses via a named Max dictionary:

| dict | direction | contents |
|---|---|---|
| `bsv_snapshot` | lom → node | the whole set |
| `bsv_ops` | node → lom | the op batch to apply |
| `bsv_result` | lom → node | applied / skipped / total |
| `bsv_palette` | lom → node | derived colors |

Names are global, so **one device instance per Live set**.

## LOM gotchas worth knowing before you touch `lom.ts`

- **`get()` returns Max atoms, not values.** Usually an array even for a single value;
  a multi-word name may arrive as one element or several. Always go through
  `gstr` / `gnum` / `gbool` / `gids` / `gid`.
- **Setting a name needs quoting.** Unquoted, `a.set('name', 'Arp Jam 1')` arrives as
  a list of atoms and only `Arp` survives. `setName()` handles it.
- **Address by id, not path string, in hot loops.** Resolving
  `live_set tracks 3 clip_slots 412` parses and walks that path every time. One
  `get('clip_slots')` per track returns every id, and `'id N'` resolves directly.
- **`get('clip')` beats `get('has_clip')`.** It answers occupancy *and* yields the
  clip's id, replacing the probe plus a second path resolution. `0` means empty.
- **Reuse one `LiveAPI` cursor with `goto()`** rather than constructing new ones. But
  beware: `at()` returns *the same object* every time, so you can't hold two cursors
  from it at once. `palette()` constructs its own for exactly this reason.
- **LOM work runs on Live's main thread.** A tight multi-thousand-op loop freezes the
  UI and can glitch audio. Writes go through a `Task` in chunks of `CHUNK = 50`,
  yielding between chunks — which also gives progress reporting for free.
- **There is no undo.** LOM writes don't participate reliably in Live's undo history.
  Our app has to own it.
- **There is no scene-move API.** Reordering means duplicate-then-delete across every
  track. This is why setlist reordering is out of MVP scope.
- **There is no Session View layout in the LOM** — no column widths, no row heights,
  nothing about how the grid is drawn. `Track.View` is `selected_device`,
  `device_insert_mode`, `is_collapsed` (documented as the *arranger*, not the session)
  and `select_instrument`. Those widths live only in the `.als`, which we don't parse,
  so anything layout-shaped is ours to invent — see `ui/README.md` *Column widths*.
  Live 12.4 ships the whole LOM docstring table inside its binary, which is the fastest
  way to settle "does the LOM expose X" without guessing:
  `strings -n 6 "/Applications/Ableton Live 12 Suite.app/Contents/MacOS/Live" | grep -n …`
- **Clips have no stable id across sessions.** `LiveAPI.id` is a runtime handle.
  Within a session, address by `(track, scene)`.
- **`notifydeleted()`** must clear observers and cancel tasks, or a reloaded device
  leaks them.

## Palette derivation

Live exposes no way to read its color palette. `palette()` derives it:

1. Append a scratch scene (`create_scene -1`).
2. Walk `color_index` upward, reading back the RGB Live assigns each one.
3. Stop when Live clamps the index — that's how the size is *discovered* rather than
   assumed. `PALETTE_MAX = 200` is only a runaway guard.
4. Delete the scratch scene in a `finally`, so it goes even if the sweep throws.

Nothing the user owns is touched. `bridge.js` caches the result to `palette.json` and
serves it at `/palette.json`, so it runs once per Live version.

## Snapshot phases

The walk is instrumented per phase because every phase is a linear scan and they
scale differently:

| phase | cost |
|---|---|
| tracks | `trackCount` |
| scenes | `sceneCount` |
| slot scan | `trackCount × sceneCount` — mostly empty slots |
| clip reads | `clipCount` |

The scan dominates on a large set, which is what the id-addressing above targets.

**The fallback is outcome-based, and it has to be.** It first keyed off the id list
coming back in an unrecognised shape — which missed the failure that actually
happened: the ids arrived fine, but nothing they addressed could be read, so all 4416
slots of a real set reported empty and the snapshot claimed zero clips. `gid()` answers
`0` both for an empty clip slot and for a cursor that never resolved, and that collapse
is what made a broken fast path indistinguishable from an empty set.

So `gref()` keeps the two apart (`-1` = unreadable, `0` = empty, `n` = clip id), and any
track whose id scan fails to read is rescanned with path addressing plus `has_clip` —
the path this project has actually watched work. When that happens `lom.js` posts the
count and a dump of the offending atoms to the Max window, which is what identifies
*which* assumption broke: whether `goto('id N')` resolves at all, or whether a clip slot
answers `get('clip')` as an `['id', n]` pair. Both are unverified, and both fail the
same silent way.

## Testing

`bridge.js` has 19 end-to-end assertions against a stubbed `max-api`, run against the
**compiled** output: static serving, path traversal, WS handshake and path, readiness
gating, request routing by id, dict staging with punctuation intact, progress
streaming, palette caching, error paths.

`lom.js` needs Live and has no automated coverage. **It's the file to suspect first.**
The parts that could be extracted are, in `core/src/lomAtoms.ts`.
