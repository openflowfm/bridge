# Reordering scenes

The four passes, what it costs, and the guards — the one write that can damage a set.

## Reordering scenes

The one write in this project that can destroy work. Everything else renames or recolors
something that still exists, and `inverseOps` reverses it out of the snapshot we already
hold — **nothing in a snapshot can rebuild a deleted scene's clips.**

Live has no move call (see [`LOM.md`](../LOM.md)), so `move` in `lom.ts` runs four passes:

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
  see [`LOM.md`](../LOM.md) — so it's wrapped in a `try` and the move still runs without it.
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
