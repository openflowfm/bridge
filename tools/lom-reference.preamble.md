# The Live Object Model

Generated. Run `npm run build:lom` after a Live upgrade; edit
[`tools/lom-reference.preamble.md`](../tools/lom-reference.preamble.md) for
everything above the class index, and `tools/lom-reference.ts` for the tables.

A checked-in copy of the LOM, so that *"does Live expose X, and can we **write**
it?"* is a lookup rather than an afternoon. Every expensive surprise this project has
had — `Scene.color_index` refusing writes, there being no session-view column width,
`goto('id N')` not resolving — was time spent answering something a table answers in a
second.

**This is reference, not narrative.** The *consequences* — which atom helper to reach
for, what to do about a nullable property — live in [`README.md`](README.md) under
*LOM gotchas*. Read that first; come here for the signature.

## Two sources, and what each is good for

| | covers | authoritative for |
|---|---|---|
| [Cycling '74's LOM page](https://docs.cycling74.com/legacy/max8/vignettes/live_object_model) | **Live 12.1** | types and access modes — the only source that states `get` / `set` / `observe` per member |
| Live's own docstring table, inside the binary | **the version you actually run** | what exists, and the failure modes. Ships with Live, so it can't be stale |

Neither is sufficient alone, which is why both are recorded here. The page is a minor
version behind and omits some members entirely; the binary has no type or access
information at all. The tables below come from the page; everything above them is
what the binary adds or contradicts.

Read the binary side with:

```sh
strings -n 4 "/Applications/Ableton Live 12 Suite.app/Contents/MacOS/Live" > live.strings
grep -n "^duplicate_clip_to$" live.strings     # then read the lines around it
```

One catch before you trust a negative result: **the binary's string table is
de-duplicated.** A name already emitted for an earlier class doesn't repeat, so
`Song.tempo` is simply absent from the `Song` block because `Scene.tempo` got there
first. Absence proves nothing; presence is what counts. For the same reason, don't try
to attribute a name to a class by block arithmetic — the blocks don't line up with the
page's class split, and a bulk diff misattributes `Song.View` members and enum
constants wholesale. Read the docstrings on either side of the name instead.

## Where 12.4.3 has more than the docs

Members that exist in Live 12.4.3's own table and appear **nowhere on the Cycling '74
page** — not as a member, not even in prose. They are real and callable, and
undocumented, so nothing here can be looked up elsewhere.

| member | class | what it does |
|---|---|---|
| `begin_undo_step` | `Song` | opens a group that a burst of writes collapses into, as one entry in Live's own undo history. Sits between `redo` and `is_playing`. |
| `end_undo_step` | `Song` | closes the step opened above |
| `scale_information` | `Song` | the current scale's intervals as ints from the root |
| `get_all_scales_ordered` | `Song` | every available scale name → intervals |
| `sync_parameter_changes` | `Song` | forces parameter changes into the document before a subsequent device operation |
| `is_session_clip` | `Clip` | true for a Session clip, as against an Arrangement one |
| `is_take_lane_clip` | `Clip` | true for a take-lane clip (always also an Arrangement clip) |
| `create_midi_clip` | `Track` | inserts an empty MIDI clip **into the Arrangement** at a time. Not the Session-grid call — `ClipSlot.create_clip` is that one. |

`begin_undo_step` / `end_undo_step` matter here more than the rest combined.
[`README.md`](README.md) has said from the start that LOM writes don't participate in
Live's undo, which is why the app owns undo itself — and for renames and recolors that
holds, with `inverseOps` reading "before" out of the snapshot. But a **structural**
change can't be reversed that way: nothing in a snapshot lets you rebuild a deleted
scene's clips. These two are the only candidate mechanism, and **whether they actually
capture LOM writes is unverified** — see *Reordering scenes* in [`README.md`](README.md).

## Where the docs are wrong

Three places the Cycling '74 page will actively mislead you.

**`Scene.color_index` is listed `get, set, observe`. You cannot write it.** The page
says only "The color index of the scene"; Live's own docstring adds *"Can be None for
no color"*, and a write answers `v8liveapi: set: unsupported property type` — Max's
LiveAPI can read an `Optional[int]` but can't construct one to write it back.
`Track.color_index` is identical. Write `color` (RGB) for scenes and tracks;
`Clip.color_index` carries no nullability note and writes fine.

The general rule, and the one to carry: **wherever Live's docstring says "can be
None", treat the page's `set` as unverified.** The page drops the nullability note,
and nullability is exactly what makes a property unwritable.

**`Scene.fire` takes `can_select_scene_on_launch`, so a scene *can* be fired without
selecting it.** [`README.md`](README.md) long said "`Scene.fire()` selects the scene …
There's no variant that doesn't." True when written, false now — 12.4.3 documents
`fire(force_legato, can_select_scene_on_launch)`, and `0` for the second fires without
moving Live's view.

**The binary documents failure modes the page omits.** `duplicate_clip_to` on the page
is one sentence about overriding the target. Live's own docstring adds that it *"Raises
an exception if the (source) slot itself is empty, or if source and target have
different track types (audio vs. MIDI). Also raises if the source or target slot is in
a group track"* — three conditions every caller must handle, documented in only one of
the two sources. **When a call can throw, check the binary.**

One shape note, since the type column doesn't make it obvious: **`duplicate_clip_to`
takes a `ClipSlot` object, not a path or an index** — through Max, an id rather than a
path string.

## What the LOM does *not* have

Answered questions, recorded so they stay answered.

- **No scene move, and no track move.** `Song` has `create_scene`, `delete_scene`,
  `duplicate_scene` and `move_device` — and nothing that reorders a scene or a track.
  Verified in both sources. The `move_scene_call` symbols in the binary belong to
  `ableton::push_live_model`, which is Push's wire protocol rather than the LOM.
  Reordering is therefore build-then-delete: `create_scene` at the destination,
  `ClipSlot.duplicate_clip_to` per occupied slot, then `delete_scene` at the source.
  See *Reordering scenes* in [`README.md`](README.md) for what that costs.
- **No session-view layout.** No column widths, no row heights.
  `Track.View.is_collapsed` is documented as the *arranger*. Those live only in the
  `.als`, which this project never parses.
- **No stable clip or scene id across sessions.** `LiveAPI.id` is a runtime handle.
  Within a session, address by `(track, scene)`.
- **No notification that the set was saved, or saved somewhere else.**
  `Song.file_path` and `Song.name` are **get-only** — the property table lists `get`
  where their neighbours say `get, observe`, and the pair of docstrings in 12.4.3's own
  table ("Get the current Live Set's path on disk." / "Get the current Live Set's
  name.") have no listener counterpart. Both exist and both are confirmed in the
  binary; neither can be observed. Anything that depends on where the set lives has to
  re-read it — `bridge.ts` does so after every snapshot. Both are empty for a set that
  has never been saved, which is a normal answer and not an error.
