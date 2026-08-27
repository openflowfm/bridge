# LOM gotchas

Read before touching lom.ts. The Live Object Model behaviours that have already cost time.

## LOM gotchas worth knowing before you touch `lom.ts`

**Signatures live in [`LOM.md`](../LOM.md)** — every class, property and function with its
type and access mode, checked in so "does Live expose X, and can we *write* it?" is a
lookup. What follows is the part a reference can't tell you: what to do about it.

Three entries below started as guesses that turned out wrong, so the habit that pays is
checking `LOM.md` **and** the version note at the top of it before assuming a property
behaves the way its name suggests.

- **Constructing a `LiveAPI` calls its callback, before you have observed anything.**
  It arrives as `['id', N]`, and the observed property usually reports right after it. Two
  separate bugs have come out of this. `meterValue` refuses the frame because reading its
  last atom as a level put every track at full scale. Worse, a callback that *infers
  nothing* — one that means "something moved, re-read everything" — will schedule the
  rebuild that is attaching it, and the rebuild attaches again: a debounced loop that never
  converges, constructing hundreds of `LiveAPI` objects a turn on the thread that draws
  Live. **Any function that both attaches observers and is reachable from one of their
  callbacks needs a re-entrancy flag.** `chainAttaching` in the device-chain watch is the
  worked example; `rebuildCursorObservers` avoids it a second way, by returning early when
  the cursor hasn't actually moved.
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
- **LOM work runs on Live's main thread**, and there is nowhere else to put it. `Task`
  schedules on that same thread and the Node half has no LiveAPI at all, so a tight
  multi-thousand-op loop freezes the UI and can glitch audio with no way around it but
  yielding. Writes chunk through a `Task` at `CHUNK = 50`; the snapshot walk chunks
  through one at `SNAP_CHUNK`, per phase. Both get progress reporting for free — and the
  progress bar only means anything *because* they yield, since nothing repaints while the
  thread is held.
- **There is no undo.** LOM writes don't participate reliably in Live's undo history.
  Our app has to own it. One caveat now worth chasing: `Song.begin_undo_step` /
  `end_undo_step` exist in Live's binary and are documented **nowhere** — see
  [`LOM.md`](../LOM.md). They're the only candidate route to making a structural change
  reversible, and whether they capture LOM writes is unverified.
- **There is no scene-move API**, in either source — see *What the LOM does not have* in
  [`LOM.md`](../LOM.md). Reordering is build-then-delete: `create_scene` at the destination,
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
  the field is `null`, the UI keeps a neutral section heading, and ordinary track following
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
  so anything layout-shaped is ours to invent — see `set/README.md` *Column widths*.
  Live 12.4 ships the whole LOM docstring table inside its binary, which is the fastest
  way to settle "does the LOM expose X" without guessing:
  `strings -n 6 "/Applications/Ableton Live 12 Suite.app/Contents/MacOS/Live" | grep -n …`
- **Clips have no stable id across sessions.** `LiveAPI.id` is a runtime handle.
  Within a session, address by `(track, scene)`.
- **A clip's times are in beats *or* seconds, and nothing in the value says which.**
  `playing_position`, `loop_start` and `loop_end` are in beats for MIDI and warped audio
  clips and in **seconds** for unwarped audio. Reading one as the other doesn't fail — it
  yields a loop phase quietly wrong by the tempo. Resolve it once from
  `is_audio_clip && !warping` and carry the answer with the numbers; `clipStatusAtoms`
  sends it as `inSeconds` for exactly this reason. `length` is worse: Live's own docstring
  says it "makes no sense for unwarped audio clips", so the loop markers are what to
  subtract rather than what to trust.
- **`Clip.playing_position` is observable, and observing it is still the wrong move.**
  The property notifies fine; the problem is that the object holding it is a *different
  clip* every time a different one starts. Following it with observers means tearing down
  and rebuilding one per track on every scene launch — on Live's main thread, at the
  moment the set is busiest. `watch_status` polls a `Task` instead, which costs a fixed
  read count and nothing while its panel is closed. This is the one place in `lom.ts`
  where polling beats observing, and the shape of the object graph is why.
- **Reading clip properties across the whole set is banned; reading the *playing* clip
  isn't.** The rule against clip-addressed reads exists because per-slot costs
  trackCount × sceneCount. A track has at most one playing clip, so anything keyed off
  `playing_slot_index` costs per track — the same budget as the play-state watcher, for
  data that would otherwise look forbidden.
- **Play state is a track property, not a clip one.** `Track.playing_slot_index` (-1 for
  none) and `Track.fired_slot_index` (-1 for none, **-2 when the track's stop button is
  fired**) describe the entire grid in two properties per track. Watching them costs
  `2 × trackCount` observers; the per-clip equivalent is two per *slot*, which is tens of
  thousands on a real set. There is no "scene is playing" property at all — the UI
  derives it from the tracks.
- **There is no "scene is playing", but there *is* "scene is launching".** `Scene.is_triggered`
  is observable and is the launch button blinking — 1 when it is pressed, 0 when the scene
  actually starts. It is the only way to tell a **launch** from an **arrival**: clip follow
  actions walk every track to the next row without setting it, which in `playing_slot_index`
  is indistinguishable from somebody launching the scene. Costs one observer per scene, so it
  is its own watch (`watch_scenes`) rather than a rider on the play watcher. **The falling
  edge is the useful one** — Live has already applied launch quantisation by then, so it lands
  on a downbeat rather than on the beat a hand moved.
- **`Track.arm` rides the play-state watcher**, one more observer on tracks that report
  `can_be_armed`. It isn't play state, but it decides what an empty slot's button *does*
  (below), so the grid needs it whether or not the mixer footer — which observes arm for
  its own strip — happens to be open. Read through `can_be_armed` rather than directly:
  `gbool` answers 0 both for a disarmed track and for a property that isn't there.
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
  erroring — *unless the track is armed*, in which case the same call starts recording
  into that slot. Both are Live's documented behaviour for one call, which is why the
  grid draws one button in every empty cell and changes only its glyph: ⌘-click and the
  button reach the same `playback clip`, and Live picks the meaning from `Track.arm`.
- **`ClipSlot.fire` takes optional args** — `(record_length, launch_quantization,
  force_legato)` — and `launch_quantization` overrides the song's global value for that
  one call. That's the non-destructive way to make audition instant, since writing
  `Song.clip_trigger_quantization` changes the user's set and LOM writes have no undo.
  **Unverified**: the arg semantics are read off the docstring table in Live's binary,
  and passing "no record length" through Max's `call()` is awkward. `playback` currently
  calls plain `fire()`.
- **`notifydeleted()`** must clear observers and cancel tasks, or a reloaded device
  leaks them. That now includes the play-state observers, which are a separate list.
- **Installing an observer fires it.** Assigning `LiveAPI.property` calls the handler once
  with the value the object already had, so *arming* a watch is indistinguishable from the
  thing it watches changing — unless the caller braces for it. This cost a release: arming
  `observe` emitted a `changed structure` per observer, which the bridge read as "the set
  was restructured", so every browser connect threw away the held set and re-walked every
  clip slot to rediscover an unchanged set. The echo is now expected on the Node side,
  where the arm happens; see *multiple clients*. Assume any new observer does this, and
  note that the echo does **not** arrive promptly — it queues behind whatever Live is
  doing, which at device start is a multi-second walk.
