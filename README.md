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

## What actually ships

Three files, and the user should only ever have to hold one of them:

```
SessionBridge.amxd    the device
bridge.js             bundled — ws inlined, and the built UI inlined as base64
lom.js                the [v8] script
```

`npm run build:bridge` runs [`../tools/build-bridge.ts`](../tools/build-bridge.ts),
which esbuilds `src/bridge.ts` into a single self-contained `bridge.js`. That's what
removes `node_modules/` and `public/` from the shipped folder — a Live device is
something people download and drag, not a directory tree they're expected to keep
together.

Two things are deliberately left external: **`max-api`**, which Max itself provides and
which cannot be bundled, and **`bufferutil` / `utf-8-validate`**, `ws`'s optional native
speedups that it `require`s inside a `try` and does without.

**`npm run dev` does not use the bundler.** It keeps `tsc --watch`, which is faster, and
leaves the inlined-asset global undefined — so the bridge serves `public/` off disk while
vite owns the UI. Serving prefers a real `public/` folder when one exists and falls back
to the inlined copy, which also means you can drop a rebuilt UI next to a shipped device
without rebuilding the device.

The end goal is **one file**: Live's Freeze button inlines a device's dependencies into
the `.amxd` itself, which is how a 2 MB single-file device on maxforlive.com works. See
[`../tools/README.md`](../tools/README.md) for the container format and how to read one
back. Whether freeze reaches `node.script`'s file the way it reaches `[js]`/`[v8]`
scripts is **unverified** — check it with `node tools/amxd.ts inspect` on a frozen build.

## Loading it in Live

1. Drop `SessionBridge.amxd` onto any track. It's an audio effect with a
   `plugin~ → plugout~` passthrough, so it's inert on the signal path — the Master
   track is a fine home.
2. Wait for the status to read `No connections`, then click **Open Session Manager** —
   it should go to `1 connection` as the browser attaches.

| status | means |
|---|---|
| `Starting…` | patcher loaded, Node hasn't booted |
| `Waiting for Live` | Node is listening, LOM handshake hasn't completed |
| `No connections` | serving, nothing attached — the resting state |
| `1 connection` / `3 connections` | that many clients are on the socket |

The count is deliberately the headline: whether the device reached Live is true within a
frame of it loading and says nothing, whereas whether a browser is attached — and how
many tabs are quietly fighting over the same set — is the thing a glance at the rack
can't otherwise tell you.

Stuck on either of the first two? **Options ▸ Max ▸ Open Max Window** — that's where
every error and every timing line lands.

**Keep the three files together.** The device resolves `bridge.js` and `lom.js`
relative to its own location, so load the `.amxd` from this repo rather than copying it
into the User Library alone. This is the constraint freezing is meant to remove — see
*What actually ships*.

Set-owned configuration is a hidden Blob parameter in the device, so Live saves it in
the `.als` and it moves wherever the set moves. Replacing the source folder costs it
nothing. An older `bsv.json` or `roles.json` is read once when an empty device migrates;
new writes never create a sidecar file.

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

`lom.ts` still emits into `bridge/` with `rootDir: "src"` — Max's `[v8]` loads
`bridge/lom.js` directly, and it can never import anything regardless (see above).
`bridge.ts` does not: it's bundled by esbuild instead — `tools/build-bridge.ts` for the
shipped build, `tools/dev-bridge.ts` for the dev watch loop — specifically so it can
import across the `core/` package boundary (the song list Push shows needs `derive()`).
Bundling doesn't care where an import lives, which is what made that possible;
`bridge/tsconfig.node.json` is typecheck-only now, and nothing asks `tsc` to emit
`bridge.ts` at all. It still reads protocol types off the global `BSV` namespace rather
than importing `protocol/` directly — nothing forces that anymore, it's just how it's
always been done here, not a constraint left over from `rootDir`.

Compiling `lom.ts` into this folder *improves* the dev loop for that half:
`autowatch = 1` watches the emitted `lom.js`, so `[v8]` only reloads on a successful
compile. A successful reload resets all of `lom.js`'s globals without reloading the Max
device, so the patcher holds an initialization latch outside the script: `lom.js` emits
a private `boot` from `loadbang`, and the patcher replays `init` only if
`live.thisdevice` has already completed. `bridge.ts`'s dev loop gets the same
successful-build-only property from `tools/dev-bridge.ts`'s esbuild watcher —
`node.script @watch 1` reloads only when it writes a new `bridge/bridge.js`.

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
| `apply <reqId> <dictName>` | execute an op batch — `{ ops, sceneOps }` |
| `add_scenes <reqId> <dictName>` | insert and configure blank scenes — `{ addition }` |
| `move <reqId> <dictName>` | reorder scenes — `{ plan }`. See *Reordering scenes* |
| `palette <reqId>` | developer-only sweep of Live's color palette |
| `diag <what> [arg]` | developer-only probes — see *Diagnostics* below. Answers go to the Max window, so there's no reply |
| `playback <verb> <i> <j>` | fire or stop something — see below |
| `select_scene <scene>` | select an exact scene and reveal it in Live's Session View |
| `set_transport <encodedPatch>` | set tempo, metronome, launch quantization or current scale controls as one patch |
| `set_mixer <encodedTargetAndPatch>` | set activator, Solo, Arm, volume and/or pan on one mixer strip |
| `watch_play <0\|1>` | install / remove the play-state and Arrangement-position observers |
| `watch_meters <0\|1>` | install / remove track/Master output-level and mixer-control observers |
| `watch_transport <0\|1>` | install / remove the six fixed control-bar observers |
| `watch_selection <0\|1>` | install / remove the Session-cursor observers — see *Following Live* |
| `ping` | |

| → node | |
|---|---|
| `ready` | LOM side is live |
| `snapshot_done <reqId> <dict> <dictMs>` | |
| `apply_progress <reqId> <done> <total>` | |
| `apply_done <reqId> <dict> <ms>` | |
| `add_scenes_done <reqId> <dict> <ms>` | |
| `move_progress <reqId> <done> <total>` | |
| `move_done <reqId> <dict> <ms>` | |
| `palette_done <reqId> <dict>` | |
| `changed <kind>` | observer fired |
| `delta <dict>` | a partial re-read, pushed after a change in Live |
| `play_state <isPlaying> <playing> <fired> …` | pairs, one per track |
| `meter_levels <masterLevel> <track> <level> …` | complete current output-level frame |
| `mixer_state <encodedState>` | complete cached mixer-control state |
| `song_position <bar> <beat> <sixteenth>` | Live's Arrangement position |
| `transport_state <encodedState>` | complete tempo, metronome, launch-quantization and scale state |
| `err <reqId> <msg>` | |

Two wire messages (`launch` and `stop`) collapse onto the single `playback` message with
a verb — `clip`, `scene`, `song`, `stopTrack`, `stopClips`, `stopSong`. One handler
rather than one per verb, and specifically **not** a global called `stop`: `stop` means
something to Max in other contexts, and a top-level global with that name is a trap
waiting to be stepped on.

`select_scene` assigns `Song.View.selected_scene` using the target scene's runtime object
id. Live 12.4.3 centers that scene in Session View as part of selecting it. This is an
exact jump rather than repeated `Application.View.scroll_view` calls, so it has no
dependency on the current row, viewport size or a control surface's unpublished session
ring.

`status <n>` also travels node → lom's direction but is routed off by `[route status]`
before reaching `v8`; it only drives the device's Status line. `n` is the number of
connected clients, or `-1` while the LOM handshake is outstanding — the patcher turns
the number into words, so no string ever has to survive the crossing.

### Realtime numeric pushes use atoms, not Dicts

`play_state` and `meter_levels` break the rule below on purpose, and the reason is worth
knowing before "fixing" it: **dict names are global.** A request/response payload like
the snapshot is safe in `bsv_snapshot` because only one is ever in flight. Realtime
pushes can arrive many times a second, so a dict would race itself, `v8` overwriting it
before Node had finished reading the previous one.

Both payloads are plain numbers with no punctuation anywhere in them, which is precisely
the case atoms handle safely. Meter observers update an in-device array independently;
roughly every 33ms, the entire array crosses as one coherent frame containing every
track's and the master track's latest values. There is no queue of historical meter
callbacks to drain. Clip names never are.

Arrangement position is a separate three-integer `song_position` push. It comes from
Live's `Song.get_current_beats_song_time`, so meter changes and Live's own bar numbering
stay authoritative. `current_song_time` may notify more often than the header can show;
`lom.ts` drops repeated ticks and crosses to Node only when bar, beat or sixteenth changes.

`transport_state` has one string (`scale_name`) mixed with five numbers/booleans, so it is
JSON percent-encoded into one punctuation-safe Max atom. That avoids both a racing global
Dict and the atom splitting that would turn `Phrygian Dominant` into two arguments. Six
fixed `Song` observers feed one coalesced full-state report; tempo is rounded to the two
decimals the header can render and reports are limited to one per 50ms while automation
is moving it. `set_transport` uses the same encoding in the other direction and accepts a
partial patch, keeping one operation for related control-bar settings rather than one
message type per property.

`mixer_state` also uses a punctuation-safe encoded JSON atom because its nested state has
nullable volume and pan parameters. Parameter automation is coalesced to one push per
display frame.
The property observers update the cached strip they belong to instead of re-reading all
tracks, so automation cannot turn into a continuous LOM walk. `set_mixer` carries one
patch for one strip in the other direction and reads that strip back even when an
unchanged write produces no observer callback.

Live calls the root, scale name and Scale Mode fields its Current Scale controls. Despite
their `Song` location in the LOM, they are **not a rewrite of every clip in the Set**: the
Control Bar reflects the current/selected clips, and writes apply to those selections (or
become the setting for subsequently created clips when none is selected). The header says
“current scale” for that reason.

### Large payloads go through Dicts, never message atoms

Clip names contain spaces, commas and semicolons — all special in Max messages.
Anything bigger than a few numbers crosses via a named Max dictionary:

| dict | direction | contents |
|---|---|---|
| `bsv_snapshot` | lom → node | the whole set |
| `bsv_delta` | lom → node | a partial re-read — some tracks, in full |
| `bsv_ops` | node → lom | the op batch to apply, **or** a move plan |
| `bsv_result` | lom → node | applied / skipped / total, **or** a move's counts |
| `bsv_palette` | lom → node | derived colors |

Names are global, so **one device instance per Live set** — and see *Multiple clients*
below, because global names have consequences there too.

`apply` and `move` share `bsv_ops` and `bsv_result` rather than taking two dicts each.
That's safe for the same reason one dict per direction is: only one write is ever in
flight, and `lom.ts` refuses either message while the other is running. Per-request names
would retire the whole question — see *Multiple clients*.

#### A dict must exist before Node can write it

`Max.setDict` only works on a dict that **already exists in Max**, and max-api says so in
its own error text: *"Please make sure the requested dict exists."* Worse, Max rejects a
missing one with an **empty message**, which arrives in the UI as `apply: Error` and nothing
else.

Three of the four dicts create themselves, because `publish()` calls `new Dict(name)` before
anything reads them — which is why snapshot and palette have always worked. **`bsv_ops` is
the only one travelling node → lom**, so nothing ever created it, and staging an op batch
could never succeed. `Max.setDict` is the one direction this project had never exercised.

`ensureDicts()` in `lom.ts` now creates all four on `init` and **holds the references** — a
Max dict is reference-counted, so letting the wrapper be collected can take the dict with
it.

#### A one-element array arrives as a scalar

Max collapses a single-element array into the element itself, so a one-clip write reaches
`apply()` as an object rather than a list. Left alone `ops.length` is `undefined`, the batch
looks empty, and the write reports "0 applied" while doing nothing — silent, and
indistinguishable from a selection that had nothing to change. `apply()` re-wraps it.

#### Never let an error reach the UI without a message

`fail()` used `String((e as Error)?.message ?? e)`, and `??` doesn't catch `''`. Combined
with the two bugs above, a real failure surfaced as `color: ` — a log line with nothing after
the colon. `describe()` here, in `bridge.ts` and in `useBridge.ts` all use `||` with a real
fallback, errors name the request that failed, and the `err` handler joins every trailing
atom so an unquoted multi-word message isn't truncated to its first word.

## Multiple clients

The bridge is meant to serve more than one client; the session manager UI is just the
first. Several UI dev servers already share one device today (each proxies `/ws` to the
same bridge), so this is exercised rather than hypothetical.

**Already correct.** `pending` keys by request id and stores the originating socket, so
replies route to the client that asked. Terminal replies (`snapshot`, `applied`,
`palette`) go to the requester; `changed`, `delta`, `deviceState` and `reload` broadcast.
Each client's `BridgeClient` is its own instance, so `lastWireTiming` is per-client.

**Watches are refcounted**, which they had to become the moment `useBridge` started
following Live. Every watch is one global observer list in `lom.ts`, including the fixed
control-bar list, so a client sending `watch_play 0` on unmount used to stop play state for
every other client too — and a client that closed its tab never sent `off` at all, holding
the watch open forever.
`bridge.ts` keeps a `Set` of sockets per watch kind, releases them on socket close, and
re-arms from that record when the LOM reports ready again after a device reload.

**`on` is always forwarded and only `off` is edge-triggered**, which looks like a bug and
isn't. `watch_play` and `watch_meters` install observers per *track* (and meters also on
Master), so a client re-sends `on` to rebuild them when a snapshot finds a different track
count; suppressing that because another client already held the watch would leave the
observers addressing a set that no longer exists. Forwarding it costs nothing, because
every `watch_*` handler in `lom.ts` clears before it installs. Sets rather than counters,
so a client sending `on` twice doesn't need two `off`s to release.

**Not yet guaranteed.** Three things to fix before a second *kind* of client exists:

1. **Dict names are fixed, so a request can read another's payload.** The window is
   narrow, not wide: `lom.ts` reads and publishes synchronously inside one Max message,
   and `apply` refuses to start while a job is running. But between one side writing a
   dict and the other side's `getDict` landing, a second request can overwrite it —
   and `finishJob` clears `job` *before* publishing the result, reopening the guard
   early. Per-request names (`bsv_ops_<reqId>`) retire the whole class.
2. **`apply` rejects instead of queueing.** `if (job) return fail(reqId, 'apply already
   in progress')`. Fine for one client; for two, the second just gets an error and has
   to retry. The chunked `Task` already provides the yield points a FIFO queue needs.
3. ~~**`snapshot` doesn't coalesce.**~~ **Fixed — `snapshot` is single-flight.** A request
   arriving while a walk is running joins it rather than starting a second, and the one
   payload is sent to each joiner stamped with **its own** request id, because that id is
   what resolves the waiter at the other end. Progress fans out to joiners too, so they
   see a moving bar rather than a still modal.

   It had no guard at all, which was survivable while it took N people pressing a button
   at the same moment — and stopped being so once the app followed Live, because one
   structural change broadcasts `changed structure` and every connected client answers by
   re-walking, at ~950ms each, serialized on Live's main thread.

   **Every path that ends a walk must clear the flight**, `snapshot_done` and `err` alike.
   A flight left standing after a walk that errored collects joiners forever and answers
   none of them, and every later request queues behind a walk that is no longer running —
   a worse failure than the one that started it. `takeFlight(reqId)` is the single place
   that closes one out.

   A short reuse window on top of this was considered and dropped. It would have to live
   in `bridge.ts`, which deliberately imports nothing from the repo so it can emit to a
   flat file outside its own `rootDir` — so the rule could not go in `core/` where it
   would have tests. Single-flight already absorbs the storm it was aimed at, and serving
   a set from memory trades that for the risk of serving one that changed with no event
   to say so. Not a good trade for what was left.

   Related and narrower: **`bsv_delta` is a fixed dict name like the rest**, and a delta
   is pushed rather than requested, so two flushes 100ms apart could in principle have
   the second overwrite the dict before `bridge.ts`'s `await Max.getDict` lands. The
   failure is a garbled delta rather than a wrong grid — `prevRev` won't line up and the
   client re-walks — but it's one more instance of item 1.

`changed` still carries only a `kind`, so it remains a full re-walk for the receiver —
but that is now the *structural* path only, where a re-walk is the honest answer because
every index changed meaning. Content changes travel as `delta`, which carries its scope
and its `rev`, and that is what makes following Live cheap rather than merely correct.
See *Following Live* below.

### A structural job of ours mutes the burst it causes

`add_scenes` and `move` both create and delete scenes, and **every one of those trips the
`live_set scenes` observer**. Unmuted that is one `changed structure` per scene touched,
each of which sends every connected client on a full walk — of a set that is halfway
through being rearranged. Reading a set mid-move is worse than reading it late.

So `structuralJob` mutes the outward message for the duration and Node emits exactly one
structural event after the terminal result. The index-addressed state — the id cache, the
dirty set, the cursor's previous position — is still dropped on every callback; it is only
the message that waits. The mute outlives the job by 100ms, because Live may deliver the
last callbacks just after the final `create_scene` / `delete_scene` returns.

**A stuck mute is silent and permanent**, so every path out of `move` releases it,
including the catch that runs when the throw lands between setting it and scheduling the
task.

`move_done` broadcasts `changed structure`, **not `changed moved`**. The client re-walks on
`structure` and only logs `moved`, so the old kind announced the danger to a handler that
did nothing about it — what actually recovered other clients was the burst, mid-move. The
UI's `moveScenes` no longer asks for its own walk either; the one broadcast drives the
re-read for the client that moved and everyone else, the way `addScenes` already worked.

## LOM gotchas worth knowing before you touch `lom.ts`

**Signatures live in [`LOM.md`](LOM.md)** — every class, property and function with its
type and access mode, checked in so "does Live expose X, and can we *write* it?" is a
lookup. What follows is the part a reference can't tell you: what to do about it.

Three entries below started as guesses that turned out wrong, so the habit that pays is
checking `LOM.md` **and** the version note at the top of it before assuming a property
behaves the way its name suggests.

- **`get()` returns Max atoms, not values.** Usually an array even for a single value;
  a multi-word name may arrive as one element or several. Always go through
  `gstr` / `gnum` / `gbool` / `gids` / `gid`.
- **Setting a name needs quoting.** Unquoted, `a.set('name', 'Arp Jam 1')` arrives as
  a list of atoms and only `Arp` survives. `setName()` handles it — see the quoting note
  below, which is what it actually does about it.
- **Don't quote a name for `set`, and don't assume either way — measure it.** `[js]` lore
  says a multi-word name has to be passed as a quoted symbol or Live keeps only the first
  word. Under `v8` that is evidently wrong: this file quoted every name for months and a
  real set showed scene names carrying literal `"` characters, so a JS string is passed
  through as one symbol and needs no help. The trap is that **both failures are invisible
  from inside `lom.js`** — quote a name that shouldn't be quoted and the quotes become
  part of it, don't quote one that should be and the name is truncated, and *both `set`
  calls succeed*. Nothing throws. `setName` therefore writes the first multi-word name
  plain, reads it back, and only falls back to the quoted form if it didn't survive,
  caching the answer for the session. One extra `get` per Live session. Single-word names
  deliberately settle nothing — they round-trip identically either way, so probing on one
  would cache a coin flip.
- **`goto('id N')` does not resolve.** Measured against a real set: every one of 24 tracks
  failed, Max posted `v8liveapi: get: no valid object set` per attempt, and
  `get('clip')` on the unresolved cursor answered `1` rather than an `['id', n]` pair. This
  settles the open question the slot-scan probe was written to answer — it was the
  addressing, not the atom shape. `[js]`'s `jsliveapi` maps `goto` to **`path_goto`**,
  which is a hint about why: it takes a path, and `id N` isn't one. The id-addressed fast
  path was therefore removed from snapshots; canonical path addressing is what runs, and
  the slot scan costs ~758ms of a ~946ms walk. `diag ids` retains the explicit probe for
  rechecking a future Max build. Setting `.id` may be the real route, but `max.d.ts`
  declares it readonly and that is **unverified**.
- **A property Live documents as nullable can be read but not written.** `Scene.color_index`
  and `Track.color_index` are both "Can be None for no color", and writing either answers
  `v8liveapi: set: unsupported property type`. `Clip.color_index` has no such note and
  writes fine. Write `color` (RGB) for scenes and tracks. See *Palette derivation*.
- **Reuse one `LiveAPI` cursor with `goto()`** rather than constructing new ones. But
  beware: `at()` returns *the same object* every time, so you can't hold two cursors
  from it at once. `palette()` constructs its own for exactly this reason.
- **LOM work runs on Live's main thread.** A tight multi-thousand-op loop freezes the
  UI and can glitch audio. Writes go through a `Task` in chunks of `CHUNK = 50`,
  yielding between chunks — which also gives progress reporting for free.
- **There is no undo.** LOM writes don't participate reliably in Live's undo history.
  Our app has to own it. One caveat now worth chasing: `Song.begin_undo_step` /
  `end_undo_step` exist in Live's binary and are documented **nowhere** — see
  [`LOM.md`](LOM.md). They're the only candidate route to making a structural change
  reversible, and whether they capture LOM writes is unverified.
- **There is no scene-move API**, in either source — see *What the LOM does not have* in
  [`LOM.md`](LOM.md). Reordering is build-then-delete: `create_scene` at the destination,
  `ClipSlot.duplicate_clip_to` per occupied slot, `delete_scene` at the source. What that
  costs, and what `create_scene` does *not* carry with it, is under *Reordering scenes*
  below.
- **Group membership is a parent link, not a tree.** `Track.group_track` returns the
  *immediate* parent group's id (groups nest), and `is_grouped` only says whether there
  is one. The snapshot resolves those ids to track indexes; don't infer grouping from
  track order. `fold_state` is Live's own collapsed state, and is documented as only
  available when `is_foldable` — don't read it on a track that isn't a group, and
  `set_fold` checks `is_foldable` before writing it for the same reason. Folding is the
  one write here that isn't a set edit: it moves Live's own Session view, changes nothing
  about what plays, and deliberately isn't wrapped in an undo step.
- **Master is a Track, but not one of `Song.tracks`.** Its RGB is read separately from
  `live_set master_track color` into `Snapshot.masterColor`, and one fixed observer folds
  later recolors into the ordinary snapshot delta. Both paths are isolated from the
  established track walk: if the embedded runtime rejects the documented Master atom,
  the field is `null`, the UI keeps its neutral Songs header, and ordinary track following
  continues.
- **A group track's clip slots are real slots.** They hold no clip, and
  `ClipSlot.fire()` on one fires every clip the group has in that scene — which is how
  the grid launches groups without a message of its own, since `playback clip` addresses
  a slot by position rather than looking a clip up. `stop_all_clips` on a group track
  likewise takes its members with it. The snapshot still skips group tracks in the slot
  scan: what a group slot *shows* (whether it has anything to fire, and its color) is
  derivable from the member clips already in the snapshot, so reading
  `controls_other_clips` per slot would cost trackCount × sceneCount for an answer we
  already have. See `core/src/groupSlot.ts`.
- **A property Live documents as optional needs its own "absent" value.** A scene's
  `color_index` "Can be None for no color", and `gnum` would report that as palette
  slot 0 — a real color. `gnumOr` exists for this.
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
- **Play state is a track property, not a clip one.** `Track.playing_slot_index` (-1 for
  none) and `Track.fired_slot_index` (-1 for none, **-2 when the track's stop button is
  fired**) describe the entire grid in two properties per track. Watching them costs
  `2 × trackCount` observers; the per-clip equivalent is two per *slot*, which is tens of
  thousands on a real set. There is no "scene is playing" property at all — the UI
  derives it from the tracks.
- **A burst of observer callbacks is one event, not N.** Firing a scene changes
  `playing_slot_index` on every track at once. `onPlayChange` sets a dirty flag and
  schedules a `Task`, so 40 callbacks produce one `play_state`.
- **`Scene.fire()` selects the scene by default, but 12.4.3 lets you opt out.** The
  docstring this project was written against said only "will fire all clipslots that this
  scene owns *and select the scene itself*", and the note here used to add "there's no
  variant that doesn't". That is now wrong: the signature is
  `fire(force_legato, can_select_scene_on_launch)`, and passing `0` for the second fires
  without moving Live's view. `playback` still calls plain `fire()` — changing that is a
  real improvement for auditing a set you're labelling, and it's **unverified**, same
  class of unknown as `ClipSlot.fire`'s optional args below.
- **`ClipSlot.fire()` on an empty slot triggers that slot's stop button** instead of
  erroring, which is Live's documented behaviour and is why ⌘-clicking an empty cell
  usefully stops the track.
- **`ClipSlot.fire` takes optional args** — `(record_length, launch_quantization,
  force_legato)` — and `launch_quantization` overrides the song's global value for that
  one call. That's the non-destructive way to make audition instant, since writing
  `Song.clip_trigger_quantization` changes the user's set and LOM writes have no undo.
  **Unverified**: the arg semantics are read off the docstring table in Live's binary,
  and passing "no record length" through Max's `call()` is awkward. `playback` currently
  calls plain `fire()`.
- **`notifydeleted()`** must clear observers and cancel tasks, or a reloaded device
  leaks them. That now includes the play-state observers, which are a separate list.

## Reordering scenes

The one write in this project that can destroy work. Everything else renames or recolors
something that still exists, and `inverseOps` reverses it out of the snapshot we already
hold — **nothing in a snapshot can rebuild a deleted scene's clips.**

Live has no move call (see [`LOM.md`](LOM.md)), so `move` in `lom.ts` runs four passes:

| pass | call | |
|---|---|---|
| 1 | `Song.create_scene` | blank scenes at the destination |
| 2 | `ClipSlot.duplicate_clip_to` | the audio, slot by slot |
| 3 | property writes | the labels — see below |
| 4 | `Song.delete_scene` | irreversible |

**The arithmetic isn't here.** It arrives as data from `core/src/sceneMove.ts`, which has
an exhaustive test. Pass 1 renumbers the whole set underneath us — inserting n blanks
pushes every index at or after the destination up by n — so the scenes pass 4 deletes are
not at the indexes the UI found them at. That off-by-n deletes a song instead of moving
it, which is exactly the class of bug that belongs somewhere testable.

Five things guard it, and each closes a specific way this goes wrong:

- **Pass 3 reads the source scene's properties here, not from the plan.** `create_scene`
  makes a *genuinely* blank scene: no name, no color, no tempo, no time signature. The
  snapshot doesn't even model time signature, so copying from the live object is both more
  complete and immune to a stale snapshot. **In this project the scene name *is* the
  mapping** — a move that dropped names wouldn't lose labels, it would delete the song
  from derivation.
- **Pass 4 doesn't run if pass 2 lost anything.** Half a song moved is a mess you can fix
  by hand; half a song moved with the original already deleted is not. On any failure the
  job stops before deleting and says so, in the log and in the Max window.
- **A plan that creates and deletes different counts is refused**, in `bridge.ts` and
  again in `lom.ts`. The failure it prevents is a set one scene shorter after every drag.
- **The whole move is wrapped in `begin_undo_step` / `end_undo_step`.** Undocumented —
  see [`LOM.md`](LOM.md) — so it's wrapped in a `try` and the move still runs without it.
  Whether Live actually captures LOM writes this way is **unverified**, and it's the only
  route back that exists, so the UI says which of the two happened rather than assuming.
- **Undo is cleared, not replaced.** Scene indexes all mean something different
  afterwards, so leaving the previous entry armed would offer a ⌘Z that writes clip names
  against the wrong rows.

`notifydeleted` closes an open undo step. Leaving one open would silently swallow
everything the user does next into our half-finished move.

**`move` constructs its own cursors rather than using `at()`**, and this is the gotcha
above biting for real rather than a stylistic choice. `at()` hands back the same `LiveAPI`
object every time, so a `live_set` cursor taken from it becomes a *Scene* the moment
`copySceneProps` repositions it — and the next `create_scene` / `delete_scene` would then
be a `call` on the wrong object. Anywhere two objects are live at once here, both are
`new LiveAPI`.

**Unverified, like everything else in `lom.ts`.** Specifically: whether
`duplicate_clip_to` accepts a target as `'id', n` through Max's `call()`, whether
`begin_undo_step` does anything, and whether the time-signature writes land. The failure
mode to watch for is the one this file has produced repeatedly — the write silently does
nothing and the next snapshot reports the old value. Try it on a copy of a set first.

## Device state

Roles and the allowed-color subset live in one versioned JSON object. `bridge.ts`
encodes it as a base64url symbol and sends `device_state_set`; the generated patcher
routes that around `lom.ts` into `pattr bsv-state`. The pattr is a Max for Live Blob
parameter with `parameter_invisible: 1`, so it is Stored Only: Live writes it into the
set but does not expose meaningless automation for it.

On startup Node sends `device_state_get` explicitly. That timing is important — pattr
may restore before `node.script` has installed its handlers, so relying on the initial
output would intermittently lose state. The patcher bangs pattr and sends the resulting
symbol back as `device_state`.

`saveRoles` and `saveAllowedColors` are granular messages even though the stored object
is one blob. Two clients changing different fields cannot overwrite each other with
stale whole-object copies; the bridge merges each change into its current state and
broadcasts the new object. A save request completes only after pattr echoes the exact
base64url value; a broken route times out visibly instead of reporting false persistence.

An empty pattr imports roles from the old per-project `bsv.json` or machine-wide
`roles.json`. The UI similarly imports `bsv.allowedColors` from localStorage when the
restored object lacks that field and that browser origin has an old list, then removes
the browser value after the device write is acknowledged.

## Embedded palette

The product uses the checked-in `LIVE_PALETTE` table in `core/src/livePalette.ts`.
Startup and snapshots never add a scratch track, never derive colors, and never need a
palette cache.

Live exposes no direct palette read. The developer-only `palette` bridge/LOM message
checks the embedded table after an Ableton update by:

1. Append a scratch MIDI track (`create_midi_track -1`) and `create_clip` in its slot 0.
2. Walk the **clip's** `color_index` upward, reading back the RGB Live assigns each one.
3. Stop when Live clamps the index — that's how the size is *discovered* rather than
   assumed. `PALETTE_MAX = 200` is only a runaway guard.
4. `delete_track` in a `finally`, which takes the clip with it, so cleanup is one call
   and happens even if the sweep throws.

The diagnostic always removes the track in `finally`, returns the colors to its caller,
and persists nothing. It is never called by the shipped UI.

### What Live 12.4.3 actually answers

70 colors, all distinct, and they line up exactly with the 14 × 5 grid in Live's own color
picker — **so `color_index` is row-major across that grid**, verified against a screenshot
of it rather than assumed. Index 13 is the white swatch ending the first row; the right-hand
column runs white → greys down to `#3c3c3c`.

```
 0: ff94a6 ffa529 cc9927 f7f47c bffb00 1aff2f 25ffa8 5cffe8 8bc5ff 5480e4 92a7ff d86ce4 e553a0 ffffff
14: ff3636 f66c03 99724b fff034 87ff67 3dc300 00bfaf 19e9ff 10a4ee 007dc0 886ce4 b677c6 ff39d4 d0d0d0
28: e2675a ffa374 d3ad71 edffae d2e498 bad074 9bc48d d4fde1 cdf1f8 b9c1e3 cdbbe4 ae98e5 e5dce1 a9a9a9
42: c6928b b78256 99836a bfba69 a6be00 7db04d 88c2ba 9bb3c4 85a5c2 8393cc a595b5 bf9fbe bc7196 7b7b7b
56: af3333 a95131 724f41 dbc300 85961f 539f31 0a9c8e 236384 1a2f96 2f52a2 624bad a34bad cc2e6e 3c3c3c
```

Recorded here and in `LIVE_PALETTE`, with a regression test pinning its length,
distinctness and boundaries. The sweep is how a developer checks a future Live rather
than making every user discover the same stable table at runtime.
The theme `.ask` files contain no clip colors (only `AutomationColor`, `WaveformColor` and
friends), which is good evidence the palette is theme-independent.

### It has to be a clip, and that took two failures to learn

**Only `Clip.color_index` is a plain int.** Live's docstrings differ per class and the
difference is load-bearing:

| | |
|---|---|
| `Clip.color_index` | "Get/set access to the color index of the Clip." |
| `Scene.color_index` | "… **Can be None for no color**." |
| `Track.color_index` | "… **Can be None for no color**." |

The first version swept a scratch *scene*, and Live answered every write with
`v8liveapi: set: unsupported property type` — Max's LiveAPI can *read* an `Optional[int]`
but can't construct one to *write*. A scratch track would have failed identically. This is
also why `execOp`'s `set('color_index', …)` has always worked: it writes clips.

**The consequence for anything that colors scenes or tracks: use `color` (RGB), not
`color_index`.** Both are documented "Get/set access to the color of the … (RGB)" with no
None, so both are writable. That's the one place the project's "never write raw RGB" rule
has to bend, and it's why a trustworthy index→RGB table matters beyond the swatch picker.

### Why the failure was invisible, and the three guards

The sweep produced `{"count": 1, "colors": [0]}` and cached it. The writes silently did
nothing, and then **the same trap as the slot scan, for the third time in this file**:
`gnum` answers an unreadable or `None` property with `0`, and `0` is a real palette slot.
So `i = 0` appeared to succeed, `i = 1` appeared clamped, and the loop exited having learnt
nothing while writing a plausible-looking cache file.

1. **`exists()` before the sweep.** The whole thing reads through one object; an
   unresolved cursor is now an error, not thirty identical black entries.
2. **`gnumOr(…, -1)`, never `gnum`.** Keeps "Live gave us nothing" apart from "Live gave
   us slot 0" — the same fix as `gref`, for the same reason.
3. **An outcome check, not a read check.** Don't ask whether the reads looked right, ask
   whether the answer can be a palette at all. Under two distinct colors `palette()`
   throws instead of publishing, and posts what Live answered for `color_index`, `color`
   and `name`, plus the clip id and where the loop stopped. That dump is what turned one
   run into the diagnosis above.

`bridge.ts` also treats a degenerate cache file as **no cache at all**. That's what made
the original failure so quiet: the file existed and parsed, so the UI showed one swatch
forever rather than "not extracted yet" — the bad data was indistinguishable from data.

## Following Live

Keeping up with edits the user makes *in Live*, without an observer per slot.

**The LOM has no aggregate "a clip in this track changed" signal.** `Track.clip_slots`
is a *const* list, so it fires on membership — the scene count — and never on content.
Checked in both sources; see *What the LOM does not have* in [`LOM.md`](LOM.md). The
complete alternative is `has_clip` per slot, which is `trackCount × sceneCount`
observers: **~4,400 on a full-size set**, against the `2 × trackCount` that play state
costs. Attaching them is roughly the cost of the slot scan itself, and every structural
change invalidates the lot, because an index-addressed observer silently re-points when
a scene is inserted above it.

So watch the **cursor** instead. `Song.View.selected_track` and `selected_scene` are
both observable, and Live defines `highlighted_clip_slot` as being derived from them —
so those two *are* the Session cursor. **Two observers for the whole grid.**

```
selection moves ──> mark {new track, previous track} dirty ──> 100ms ──> re-read ──> delta
```

**The cursor says where to look; the re-read says what happened.** Nothing tries to
detect a drag or classify a drop, and that's what makes it robust — there is no
inference to get wrong. A selection change that was just a click re-reads a track, finds
it unchanged, and the client's merge is a no-op.

**Both ends, and this is the part that makes it work.** The cursor lands on a move's
*destination*; the position it left is the *source*. You have to select a clip to drag
it, so the previous cursor position is where it came from. Marking only the destination
would learn that a clip arrived and never that it left — drawing it in two places.

Measured against a real set, a click-and-drag **in one motion on an unselected clip**
fires twice: at the source on grab, at the destination on drop. That's the assumption the
whole design rests on, and it's the one `diag watch` was built to check.

### What it costs

| | |
|---|---|
| observers | 2 for the cursor + up to 3 on what it sits on, regardless of set size |
| per selection change | 2 `get`s to read the cursor ids |
| per re-read | ~11ms a track on a 64-scene set |
| full walk, for comparison | ~950ms |

Both id → index resolutions are cached (`trackIndexById`, `sceneIndexById`) and dropped on
any structural change. Resolving the track half by walking measured **11ms**, which is
nothing once and a great deal on every click the user makes in Live. The scene half is
newer and needed for the same reason: the re-read is scoped to whole tracks and never
wanted a scene index, but the slot observer below is addressed by one — and a set is far
likelier to have hundreds of scenes than hundreds of tracks.

### Edits that move nothing — the cursor sits on them

Deleting, renaming or recoloring a clip **in place** leaves the cursor where it is, so the
two cursor observers never fire. That used to be the hole, and the client covered it by
re-walking every time the window regained focus.

But the cursor is already *on* the thing being edited, because you have to select
something in Live to edit it. So watch that one object too: `has_clip` on the slot under
the cursor, plus the contained clip's `name` and `color_index`. **Three observers, and
they move with the cursor**, so the count is the same on a four-track sketch and an
848-scene set. A fire marks the cursor's own track and goes through the same debounce,
re-read and delta as a selection change — it learns nothing from *which* property fired,
because the re-read answers the same thing whichever it was, and inference is what this
design keeps out.

**They are attached from the `Task`, never from a callback.** Constructing a `LiveAPI` can
call back synchronously before the observed property reports — recorded on `meterValue` —
so attaching inside a notification risks re-entering the handler you are standing in, and
a clip that has just appeared may not resolve in the tick `has_clip` reported it. The
rebuild is unconditional rather than gated on "did the cursor move", precisely because the
clip under a *stationary* cursor is the one that comes and goes.

A slot with no clip carries one observer, not three; there is no Clip object to attach to,
and `has_clip` is what brings the other two back when one arrives.

The same argument covers the **scene and track** the cursor sits on — `Scene.name`,
`Scene.color`, `Scene.tempo`, `Track.name`, `Track.color`. A scene rename is the one that
matters most in this project, because a scene name is not a label on the mapping, it *is*
the mapping, and everything downstream is re-derived from it.

Two choices in there worth keeping:

- **`color`, not `color_index`.** Live's own docstring says a scene's `color_index` "can
  be None for no color", and `LOM.md` records the page calling it writable when it isn't —
  it is the member this project has already been wrong about once. `color` is always an
  int and moves with it, so a recolor fires either way and nothing is asked of a nullable.
- **No `tempo_enabled` observer.** Disabling a scene tempo makes `tempo` read -1 and
  enabling it makes it read a value, so the `tempo` observer already fires for both.

A group track resolves to no clip slot at all, so the slot probe is guarded by `exists`
rather than letting `get` post an error on every rebuild.

### The delta carries rows now, and they merge the other way round

`SnapshotDelta.tracks` is **`clipScope`** — which columns had their clips re-read — because
`trackRows` beside it means something else entirely: what the columns are called. Rows
travel as `sceneRows`, `trackRows` and `tempo`, absent rather than empty so a delta that is
only about clips stays exactly the message it always was. One flush, one `rev` bump, one
merge, however many of the three are dirty.

**Rows upsert by index; clips replace by scope.** `mergeRows` in `core/` has the argument:
a clip can *vanish* from a track — moved out of a slot, it is a deletion at the source, and
an upsert has no entry with which to represent one. A scene at index 5 cannot vanish that
way. Either it exists, or the set restructured, and a restructure renumbers everything and
sends every client for a full walk regardless.

`readSceneRow` and `readTrackRow` are shared by the walk and the scoped re-read, so there
is one definition of what a row is. Two would drift, and the symptom would be a grid
disagreeing with itself depending on which path last wrote a row. `readTrackRow` resolves
`groupIndex` through `trackIndexOf` rather than the walk's two-pass map, which is sound for
the reason the two-pass map exists at all: grouping cannot change without adding or
removing a track, and that is structural.

### What it still does not catch

`Clip.length` and `Track.fold_state` have **no `observe` at all** — a loop length changed
in Live, or a group folded there, is invisible to every observer this file can install.
Nor is there any way to hear about another M4L device or a remote script. Those are what
the client's staleness backstop is for, and why it wasn't deleted along with the
focus-triggered walk.

### An unchanged re-read publishes nothing

A re-read that finds a track exactly as last described must publish **nothing** — not an
empty delta, and above all not a `nextRev()`. `rev` is a single global shared by every
client, so a bump nobody needed is a chance for some *other* client's next delta to fail
`canApplyDelta` and answer with a full walk.

Before `trackDigest`, **every click the user made in Live bumped it**: a click moves the
cursor, the flush re-reads a track, finds it identical, and published that non-event
anyway. The digest is seeded free inside `snapshot()`, which has just read every clip in
the set, and it is keyed by track index — so it is dropped by the same structural change
that drops the id caches, because a surviving entry would make a genuinely changed track
look unchanged.

Our own writes are deliberately *not* exempted. An `apply` leaves the digest stale, so the
next flush re-reads and publishes — one extra ~11ms read per write, and the only
verification this project has ever had that a write landed as reported. Suppressing it
would mean matching op addresses against the re-read, which is inference of exactly the
kind that hides the failure `lom.ts` specialises in: the write that silently did nothing.

Also uncovered: anything that changes the set without touching Live's selection — another
M4L device, a remote script, and possibly undo.

### The guards

- **`prevRev`.** Revisions are a monotonic counter in `lom.ts`, bumped once per publish,
  shared by snapshots and deltas. A delta rewrites only its own scope, so applying one to
  any state but the exact one it was computed against splices two revisions of the set
  together. A mismatch is a *missed message*, and the answer is a full walk, not a retry.
- **Scope-then-replace, never upsert.** The merge is `mergeTrackDelta` in `core/`, where
  it has tests. An upsert by `(t, s)` keeps a clip the user deleted, because a deleted
  clip has no incoming entry to overwrite it — and a clip moved *out* of a slot is a
  deletion at the source. See [`../core/README.md`](../core/README.md).
- **A write in flight defers the flush** — `job`, `moveJob` **and `clipJob`**. Each is
  reconciled by the client from the batch or plan it sent, and a delta computed against a
  half-written set races that. `clipJob` was missing, and a clip drag is precisely the
  case where it bites: the client is patching via `applyClipMove` from its own plan while
  the delta describes a grid halfway through the copy pass. `finishJob` also clears `job`
  *after* publishing rather than before, which used to reopen the guard early.
  Our own writes still don't move Live's selection — but the cursor observers fire on
  them, so this is now the common path rather than belt-and-braces.
- **A structural change drops everything index-addressed** — both id caches, the digests,
  the dirty set, the cursor's previous position, and the cursor observers themselves. That
  last one matters most: they are path-addressed, and a path silently re-points when a
  scene is inserted above it, so an observer left attached goes on reporting about the
  wrong slot and nothing ever says so. Clients re-walk on `changed structure`.
- **A track that no longer resolves is omitted, not reported empty.** Claiming it is
  empty would delete its clips from the client's copy.

## Diagnostics

`diag <what> [arg]`, sent by [`../tools/diag.ts`](../tools/diag.ts) and never by the
shipped UI — the same standing as `palette`.

```sh
npm run dev:diag -- sel
npm run dev:diag -- watch 1     # then drag a clip in Live
npm run dev:diag -- scroll 1    # one Session-view step down; -1 goes up
npm run dev:diag -- selectscene 42  # select scene 42 directly; zero-based
```

**The answers land in the Max window, not on the wire**, which is why this message has
no reply event and nothing in `TERMINAL`. These probes settle behavior visible only with
Live open, so the readout has to be somewhere you can watch without leaving Live.

| what | question it settles |
|---|---|
| `ids` | does `goto('id N')` resolve? Decides whether the slot scan can be made fast **and** whether an observer can be attached by id |
| `slot` | is `ClipSlot.color_index` the contained clip's color on an *ordinary* slot, and does an empty slot answer None? |
| `sel` | where is the Session cursor, and what does `Track.is_part_of_selection` cover? |
| `watch 0\|1` | does moving a clip in Live move the cursor — at the source *and* the target? |
| `scan <track>` | what one track's occupancy rescan costs |
| `attach <n>` / `detach` | what N slot observers cost to install, and whether they slow *Live* down |
| `scroll <signed steps>` | does one `Application.View.scroll_view` call move Session by exactly one scene row? Positive is down; negative is up |
| `selectscene <index>` | does assigning an exact `Song.View.selected_scene` also reveal and center that scene? The index is zero-based |

`scroll` established that one call moves the selected scene exactly one row and centers
it in Session View. A synchronous loop of calls produced only one move, so the probe now
schedules multiple calls 50ms apart to test whether Live's deferred UI work was
coalescing them. The LOM still exposes no current offset, visible range or result saying
whether the view moved. That leaves two candidates for absolute scrolling: assign the
target directly through `selected_scene`, or send the required number of scheduled
relative calls. `selectscene` tests the direct path. Its readback can prove the scene
became selected; whether Live also centers it is visible only in Live itself.

Three of these exist to settle whether the set can be kept in sync by watching Live's
**selection** rather than every clip slot. The reasoning: there is no aggregate "a clip
in this track changed" observable (see [`LOM.md`](LOM.md)), but `selected_track` and
`selected_scene` are observable and cost two observers total — and you have to select a
clip to move it. So the cursor says *where to look* and a targeted re-read says *what
happened*, with no drag/drop inference to get wrong.

`watch` is the one that decides it. **Two lines per drag** — one naming the source slot,
one the target — is what the design needs. One line means only the drop is visible, and
a resync driven by it would leave the source stale, drawing the clip in both places.

`attach`'s useful output isn't in its own log. Install the observers, then use Live
normally — delete a scene, undo something — and see whether *Live* got slower. Observer
callbacks run on Live's main thread, so the cost lands on Live's own operations, which
is what a user would notice and blame the device for.

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

**Snapshots use canonical path addressing plus `has_clip`.** An earlier id-addressed
fast path was guarded by an outcome-based fallback, but `goto('id N')` is known not to
resolve under this v8 LiveAPI build. It therefore emitted one `get: no valid object set`
per non-group track on every walk before doing the canonical path scan anyway. The dead
probe was removed; `diag ids` is the explicit, developer-only place to re-test id
addressing after a Max upgrade.

## Testing

`bridge.js` has 19 end-to-end assertions against a stubbed `max-api`, run against the
**compiled** output: static serving, path traversal, WS handshake and path, readiness
gating, request routing by id, dict staging with punctuation intact, progress
streaming, palette caching, error paths.

`lom.js` needs Live and has no automated coverage. **It's the file to suspect first.**
The parts that could be extracted are, in `core/src/lomAtoms.ts`.

- **`Scene.tempo` needs `tempo_enabled` set first, and the order is load-bearing.** Live
  documents the pair as "the song will use the scene's tempo as soon as the scene is
  fired" / "when disabled, the scene will use the song's tempo, and the tempo value
  returned will be -1". So writing `tempo` to a disabled scene lands nowhere and reads
  back -1 — visually identical to the write never happening. `setSceneTempo` enables then
  writes, and disables *without* writing a value it's about to switch off. Live's own
  bound, from an assertion in the binary, is `>= 20.0 && <= 1000.0`.

**`execSceneOp` is unverified.** Nothing has yet written a scene name or a scene color
against a real set. The name half goes through the same `setName` the clip path has
always used, so it's the low-risk half; the color half writes plain `color` (RGB) rather
than `color_index`, which is the form the palette-derivation failure established as the
writable one for scenes — but *reading* that conclusion off a failed `color_index` write
is not the same as having watched a scene change color. If it's wrong, the failure mode
is the one this file has produced three times before: the write silently does nothing and
the following snapshot reports the old color, which looks like the UI not having sent
anything. The name write landing while the color doesn't is the signature to look for.

**Scene tempo is unverified in the same way**, and fails identically: if the
`tempo_enabled` ordering is wrong, `Scene.tempo` reads back -1 and the write looks like
it never happened. The check that costs nothing is to fire a scene after setting it — the
song tempo should follow.

**The new control-bar observer and writes are also unverified in Live.** All six members
are documented `get, set, observe` on `Song`, and the bridge reports Live's readback rather
than trusting the attempted patch. Still, `lom.ts` has no automated host coverage. Check
tempo, metronome, clip-trigger quantization, root note, scale name and Scale Mode against
Live's own Control Bar with the device loaded; a missing `transport_state` or an unchanged
readback is the visible, harmless failure mode.
