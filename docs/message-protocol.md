# Message protocol between the halves

Node ↔ v8 messaging: atoms for realtime pushes, Dicts for large payloads, and the failure modes of each.

## Message protocol between the halves

Not the WebSocket protocol — see [`../protocol/README.md`](../../protocol/README.md) for
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
| `set_transport <encodedPatch>` | set tempo, metronome, launch quantization, Arrangement Record or current scale controls as one patch |
| `set_mixer <encodedTargetAndPatch>` | set activator, Solo, Arm, volume, pan and/or one indexed send on one mixer strip |
| `watch_play <0\|1>` | install / remove the play-state and Arrangement-position observers |
| `watch_meters <0\|1>` | install / remove track/Master output-level and mixer-control observers |
| `watch_sends <0\|1>` | add / remove the optional per-track send observers and return-track observer |
| `watch_transport <0\|1>` | install / remove the seven fixed control-bar observers |
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
| `play_state <isPlaying> <playing> <fired> <armed> …` | triples, one per track |
| `meter_levels <masterLevel> <track> <level> …` | complete current output-level frame |
| `clip_status <t> <pos> <loopStart> <loopEnd> <looping> <recording> <inSeconds> <sigNum> <sigDen> …` | nine atoms per *playing* track; silent tracks are absent |
| `mixer_state <encodedState>` | complete cached mixer-control state |
| `song_position <bar> <beat> <sixteenth>` | Live's Arrangement position |
| `transport_state <encodedState>` | complete tempo, metronome, launch-quantization, Arrangement Record and scale state |
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

`play_state`, `meter_levels` and `clip_status` break the rule below on purpose, and the reason is worth
knowing before "fixing" it: **dict names are global.** A request/response payload like
the snapshot is safe in `bsv_snapshot` because only one is ever in flight. Realtime
pushes can arrive many times a second, so a dict would race itself, `v8` overwriting it
before Node had finished reading the previous one.

Both payloads are plain numbers with no punctuation anywhere in them, which is precisely
the case atoms handle safely. Meter observers update an in-device array independently;
roughly every 33ms, the entire array crosses as one coherent frame containing every
track's and the master track's latest values. There is no queue of historical meter
callbacks to drain. Clip names never are.

`clip_status` is the same shape and the same reasoning, with one difference worth
knowing: **it is polled, where everything else here is observed.** `Clip.playing_position`
is observable, but the object that holds it is a different clip every time a different
one starts — so an observer design means tearing down and rebuilding one observer per
track on every scene launch, on Live's main thread, at the moment the set is busiest. A
repeating `Task` at 50ms costs a fixed, predictable number of reads and nothing at all
while the stop row is closed.

The read count is kept down by splitting the clip's facts in two. Only the playhead and
the recording flag can change without the *playing slot* changing, so those are read
every tick and the loop markers, signature and beats-or-seconds unit are cached until
Live reports a different slot in that track. A frame identical to the last one is
dropped in `v8`, so a stopped set broadcasts nothing rather than the same empty frame
twenty times a second.

This is also the only place the device reads *clip* properties for the whole set, which
the protocol rules otherwise forbid. It is affordable for the reason the ban exists: a
track has at most one playing clip, so it costs per **track**, not per slot.

Arrangement position is a separate three-integer `song_position` push. It comes from
Live's `Song.get_current_beats_song_time`, so meter changes and Live's own bar numbering
stay authoritative. `current_song_time` may notify more often than the header can show;
`lom.ts` drops repeated ticks and crosses to Node only when bar, beat or sixteenth changes.

`transport_state` has one string (`scale_name`) mixed with six numbers/booleans, so it is
JSON percent-encoded into one punctuation-safe Max atom. That avoids both a racing global
Dict and the atom splitting that would turn `Phrygian Dominant` into two arguments. Seven
fixed `Song` observers feed one coalesced full-state report; tempo is rounded to the two
decimals the header can render and reports are limited to one per 50ms while automation
is moving it. `set_transport` uses the same encoding in the other direction and accepts a
partial patch, keeping one operation for related control-bar settings rather than one
message type per property.

`mixer_state` also uses a punctuation-safe encoded JSON atom because its nested state has
nullable volume, pan and send parameters. Parameter automation is coalesced to one push
per display frame. Sends are indexed in the same order as `Song.return_tracks`; changing
that list rebuilds the send portion of every cached strip.
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
