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
2. Wait for the status line to read `connected to Live`, then click **Open Session
   Manager**.

| status | means |
|---|---|
| `starting…` | patcher loaded, Node hasn't booted |
| `server up` | Node is listening, LOM handshake hasn't completed |
| `connected to Live` | both halves talking |

Stuck on either of the first two? **Options ▸ Max ▸ Open Max Window** — that's where
every error and every timing line lands.

**Keep the three files together.** The device resolves `bridge.js` and `lom.js`
relative to its own location, so load the `.amxd` from this repo rather than copying it
into the User Library alone. This is the constraint freezing is meant to remove — see
*What actually ships*.

State is not among those files and never has to move with them: the palette cache lives
under Application Support and the role vocabulary lives beside your `.als`, so replacing
the folder wholesale costs you nothing. An older install that wrote `roles.json` or
`palette.json` into this folder is adopted once, on the next boot, with a line in the
Max window saying so.

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
| `apply <reqId> <dictName>` | execute an op batch — `{ ops, sceneOps }` |
| `move <reqId> <dictName>` | reorder scenes — `{ plan }`. See *Reordering scenes* |
| `palette <reqId>` | derive Live's color palette |
| `playback <verb> <i> <j>` | fire or stop something — see below |
| `watch_play <0\|1>` | install / remove the play-state and Arrangement-position observers |
| `watch_meters <0\|1>` | install / remove the per-track output-meter observers |
| `ping` | |

| → node | |
|---|---|
| `ready` | LOM side is live |
| `snapshot_done <reqId> <dict> <dictMs>` | |
| `apply_progress <reqId> <done> <total>` | |
| `apply_done <reqId> <dict> <ms>` | |
| `move_progress <reqId> <done> <total>` | |
| `move_done <reqId> <dict> <ms>` | |
| `palette_done <reqId> <dict>` | |
| `changed <kind>` | observer fired |
| `play_state <isPlaying> <playing> <fired> …` | pairs, one per track |
| `meter_levels <track> <level> …` | complete current track/output-level frame |
| `song_position <bar> <beat> <sixteenth>` | Live's Arrangement position |
| `err <reqId> <msg>` | |

Two wire messages (`launch` and `stop`) collapse onto the single `playback` message with
a verb — `clip`, `scene`, `song`, `stopTrack`, `stopClips`, `stopSong`. One handler
rather than one per verb, and specifically **not** a global called `stop`: `stop` means
something to Max in other contexts, and a top-level global with that name is a trap
waiting to be stepped on.

`serving` also travels node → lom's direction but is routed off by `[route serving]`
before reaching `v8`; it only drives the device's status line.

### Realtime numeric pushes use atoms, not Dicts

`play_state` and `meter_levels` break the rule below on purpose, and the reason is worth
knowing before "fixing" it: **dict names are global.** A request/response payload like
the snapshot is safe in `bsv_snapshot` because only one is ever in flight. Realtime
pushes can arrive many times a second, so a dict would race itself, `v8` overwriting it
before Node had finished reading the previous one.

Both payloads are plain numbers with no punctuation anywhere in them, which is precisely
the case atoms handle safely. Meter observers update an in-device array independently;
roughly every 33ms, the entire array crosses as one coherent frame containing every
track's latest value. There is no queue of historical meter callbacks to drain. Clip
names never are.

Arrangement position is a separate three-integer `song_position` push. It comes from
Live's `Song.get_current_beats_song_time`, so meter changes and Live's own bar numbering
stay authoritative. `current_song_time` may notify more often than the header can show;
`lom.ts` drops repeated ticks and crosses to Node only when bar, beat or sixteenth changes.

### Large payloads go through Dicts, never message atoms

Clip names contain spaces, commas and semicolons — all special in Max messages.
Anything bigger than a few numbers crosses via a named Max dictionary:

| dict | direction | contents |
|---|---|---|
| `bsv_snapshot` | lom → node | the whole set |
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
`palette`) go to the requester; only `changed`, `paletteUpdated` and `reload` broadcast.
Each client's `BridgeClient` is its own instance, so `lastWireTiming` is per-client.

**Not yet guaranteed.** Four things to fix before a second *kind* of client exists:

1. **Dict names are fixed, so a request can read another's payload.** The window is
   narrow, not wide: `lom.ts` reads and publishes synchronously inside one Max message,
   and `apply` refuses to start while a job is running. But between one side writing a
   dict and the other side's `getDict` landing, a second request can overwrite it —
   and `finishJob` clears `job` *before* publishing the result, reopening the guard
   early. Per-request names (`bsv_ops_<reqId>`) retire the whole class.
2. **`apply` rejects instead of queueing.** `if (job) return fail(reqId, 'apply already
   in progress')`. Fine for one client; for two, the second just gets an error and has
   to retry. The chunked `Task` already provides the yield points a FIFO queue needs.
3. **`snapshot` doesn't coalesce.** There's no guard at all, so N clients asking at
   once means N full LOM walks serialized on Live's main thread — and the walk is the
   expensive part. Single-flight plus a cache keyed by `rev` (already in the payload)
   is the fix.
4. **`observe` has no refcount.** The bridge forwards `observe on|off` straight to a
   global toggle that clears and rebuilds all observers, so one client turning it off
   silently blinds the others, and a client that vanishes never decrements. Latent
   today — nothing in `ui/` sends `observe` yet — which makes now the cheap time.

Related: `changed` carries only a `kind`, so a client's only response to someone else's
write is a full re-walk. Carrying the affected slots and the new `rev` is what makes
multi-client cheap rather than merely correct. See [`protocol/README.md`](../protocol/README.md).

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
  fell back, Max posted `v8liveapi: get: no valid object set` per attempt, and
  `get('clip')` on the unresolved cursor answered `1` rather than an `['id', n]` pair. This
  settles the open question the slot-scan fallback was written to answer — it was the
  addressing, not the atom shape. `[js]`'s `jsliveapi` maps `goto` to **`path_goto`**,
  which is a hint about why: it takes a path, and `id N` isn't one. The id-addressed fast
  path is therefore dead weight today; the fallback is what runs, and the slot scan costs
  ~758ms of a ~946ms walk. Setting `.id` may be the real route, but `max.d.ts` declares it
  readonly and that is **unverified**.
- **A property Live documents as nullable can be read but not written.** `Scene.color_index`
  and `Track.color_index` are both "Can be None for no color", and writing either answers
  `v8liveapi: set: unsupported property type`. `Clip.color_index` has no such note and
  writes fine. Write `color` (RGB) for scenes and tracks. See *Palette derivation*.
- **`get('clip')` beats `get('has_clip')`.** It answers occupancy *and* yields the
  clip's id, replacing the probe plus a second path resolution. `0` means empty.
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
  slot 0 — a real color. `gnumOr` exists for this; see also `gref` for object refs.
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

## Palette derivation

Live exposes no way to read its color palette. `palette()` derives it:

1. Append a scratch MIDI track (`create_midi_track -1`) and `create_clip` in its slot 0.
2. Walk the **clip's** `color_index` upward, reading back the RGB Live assigns each one.
3. Stop when Live clamps the index — that's how the size is *discovered* rather than
   assumed. `PALETTE_MAX = 200` is only a runaway guard.
4. `delete_track` in a `finally`, which takes the clip with it, so cleanup is one call
   and happens even if the sweep throws.

Nothing the user owns is touched. `bridge.js` caches the result to `palette.json` and
serves it at `/palette.json`, so it runs once per Live version.

## The role vocabulary

**`bsv.json`, in the folder holding the open `.als`.** Served at `/roles.json`, written
by the `saveRoles` message. It holds the list of roles and each one's palette slot —
**not** which scene has which role, which lives in the scene names inside the set (see
[`../core/README.md`](../core/README.md)).

Per set, because a vocabulary describes the songs in one show. It travels with the set:
copy the project folder to another machine and the colors come with it, which no amount
of per-machine state can do.

Server-side rather than `localStorage` for three reasons: the UI is served from two
origins (`:5173` in dev, `:17800` shipped), so browser storage would quietly diverge
between them; a cache clear before a gig shouldn't cost you your color scheme; and a
vocabulary in a browser can't follow the set anywhere.

### Which file, exactly

| the open set | vocabulary read from | written to |
|---|---|---|
| saved | `<project folder>/bsv.json`, else the machine-wide file as a seed | `<project folder>/bsv.json` |
| never saved | the machine-wide file | the machine-wide file |
| saved somewhere that doesn't exist | the machine-wide file, with a line in the Max window | the machine-wide file |

The machine-wide file is `roles.json` under `~/Library/Application Support/Session Bridge/`
(`%APPDATA%\Session Bridge` on Windows, `BSV_STATE_DIR` overrides both). It is the
fallback for an unsaved set and the **seed** for a saved one that has no `bsv.json` yet,
so a new set opens with the colors you last used rather than nothing. It is never
written back to on its own — the first `saveRoles` in a saved set writes that set's file
and leaves the seed alone.

One consequence of keying on the folder rather than the `.als`: several sets in one Live
Project share a vocabulary. For versions of the same show — which is what Save As
mostly produces — that's the point, since the colors follow. Two unrelated songs in one
project would share one too.

### Finding out which set is open

`Song.file_path` is **get-only. There is no observer for it** — the property table lists
`get` where its neighbours say `get, observe`, and Live 12.4.3's own docstring ("Get the
current Live Set's path on disk.") has no listener counterpart. So **nothing can tell us
the user chose Save As.**

The bridge therefore asks, rather than subscribing: `set_info` → `set_info_done <dict>`,
sent once when the LOM signals ready and again after every `snapshot_done`. A snapshot is
when the UI re-syncs anyway, and the extra cost is two property reads and no walk. When
the answer changes, the bridge broadcasts `setInfo` and every open client refetches its
vocabulary — the one it loaded a moment ago may belong to a different set entirely.

It travels by Dict, not atoms, for the reason in *Large payloads go through Dicts*: a
path has spaces in it. Note the residue of that — `gstr` rebuilds a symbol property by
joining its atoms with a single space, so a path containing **two** consecutive spaces
comes back subtly wrong. That's why the folder is checked for existence on every use
instead of being trusted once: a wrong-but-plausible directory would otherwise get a
`bsv.json` written into it silently.

Unlike the palette, **an empty vocabulary is a correct steady state** — it's what a new
set has — so nothing found answers `200` with `{"roles":[]}` rather than `404`.
There's nothing to derive and nothing to retry, which is the opposite of the palette's
situation. The write is write-then-rename: a half-written file would parse as invalid
JSON and the UI would come up with no vocabulary at all, the same shape of failure the
degenerate palette cache caused.

**The palette does not move with it.** It's Live's color table, the same 70 entries
whichever document is open, and deriving it costs a scratch scene — so it stays
machine-wide even though the vocabulary that indexes into it is per-set.

**The UI triggers it, once, before the first walk** — see `ui/README.md` *Palette*. Not on
every snapshot: the sweep mutates the set, so that would dirty the document on every
refresh, churn Live's undo history, and fire the structural observer whose whole purpose is
to prompt a re-snapshot.

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

Recorded for reference and as a regression check, **not** as a hardcoded table — the sweep
stays the source of truth so a future Live with a different palette isn't silently wrong.
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
