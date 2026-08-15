# Following Live

The Session cursor observers, what a delta carries, what it still does not catch, and the guards.

## Following Live

Keeping up with edits the user makes *in Live*, without an observer per slot.

**The LOM has no aggregate "a clip in this track changed" signal.** `Track.clip_slots`
is a *const* list, so it fires on membership — the scene count — and never on content.
Checked in both sources; see *What the LOM does not have* in [`LOM.md`](../LOM.md). The
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

### The bridge follows Live too, not only the clients

A delta is broadcast, and `bridge.ts` is one of the things reading it. It holds the last
snapshot and the `SetModel` read from it, and merges each delta into that copy with the
same `core/` functions the browser uses — one set of arithmetic with tests, not two.

**The model is rebuilt only when the delta carried `sceneRows`.** Everything in a
`SetModel` is a function of scene names and `Scene.tempo`, which is exactly what those rows
carry, so a clip-only delta cannot change a single song. When it *is* rebuilt it rides
along on the broadcast `delta` event as `model`, and Push's encoder list is relabelled from
the same object. A rename is the case that matters: `apply` broadcasts `changed applied`
rather than `structure`, so a delta is the only thing that says scene names moved.

A `prevRev` that doesn't line up drops the held set rather than merging — see
[*Dropped on any doubt at all*](multiple-clients.md). The next request walks and restores
it; a missed message is not on its own worth interrupting Live for.

### What it still does not catch

`Clip.length` and `Track.fold_state` have **no `observe` at all** — a loop length changed
in Live, or a group folded there, is invisible to every observer this file can install.
Nor is there any way to hear about another M4L device or a remote script. Those are what
the staleness backstop is for, and why it wasn't deleted along with the focus-triggered
walk. It runs **here**, in `bridge.ts`, on a fixed tick — the observers in this file are
the device's, so the periodic look that covers their blind spots is the device's too.

They are also the whole reason `snapshot` still has a `fresh` flag now that the bridge
holds the set: held state is exactly as current as the signals that maintain it, and
these have no signal at all. `fresh: true` is a client saying "don't tell me what you
hold, go and look".

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
  deletion at the source. See [`core/docs/snapshotDelta.md`](../../core/docs/snapshotDelta.md).
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
