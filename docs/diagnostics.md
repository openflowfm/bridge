# Diagnostics, snapshot phases and testing

The diagnostic surfaces, the phase breakdown, and what can be tested without Live.

## Diagnostics

`diag <what> [arg]`, sent by [`../tools/diag.ts`](../../tools/diag.ts) and never by the
shipped UI — the same standing as `palette`.

```sh
npm run dev:diag -- sel
npm run dev:diag -- watch 1     # then drag a clip in Live
npm run dev:diag -- scroll 1    # one Session-view step down; -1 goes up
npm run dev:diag -- selectscene 42  # select scene 42 directly; zero-based
npm run dev:diag -- param       # what Live thinks this device's parameters are
npm run dev:diag -- labels 8    # write 8 synthetic value labels, then re-read
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
| `param` | what does Live expose for this device's own parameters — name, range, and the `value_items` Push draws its value text from? |
| `labels <n>` | write `n` synthetic value labels to the Push song parameter, then re-read. `0` clears the list |
| `labelspaces` | the same write, with one two-word label spaced normally and one joined by a non-breaking space — the shipped form against the retired one |
| `bank` | redefine the `live.banks` page, so a label written after the page appeared gets a second chance to be seen |

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
in this track changed" observable (see [`LOM.md`](../LOM.md)), but `selected_track` and
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

### The Push labels

The last four were built for one question — the song names had never appeared on a Push,
and everything else about that encoder worked — and they answered it. They take the set
out of the frame: the labels are `L1`, `L2`, … and come from nowhere but
`diagPushLabels`, so what is under test is the message and the parameter alone.

**The names are on the display now.** A runtime `_parameter_range` does reach
`value_items`, so Live re-reads an Enum's item list after the device has loaded. Push
does not — it keeps the labels it held when the bank page appeared, and a plain write
stayed invisible until Push was restarted. Redefining the page after every write is what
closed that gap.

`labels` writes and then re-reads, so one command produces both halves. Read the second
line against the first:

| `min`/`max` | `value_items` | what it means |
|---|---|---|
| moved | moved | Live has the names — the case that now holds. Anything still blank on hardware is Push's own caching, and `bank` is the lever |
| moved | unchanged | Max took the item list; Live's copy is frozen at device load. **The labels cannot arrive this way at all** |
| unchanged | unchanged | Max refused the message. Vary the shape — the count with `labels <n>`, the spaces with `labelspaces` |

The `live.banks` page is defined at `live.thisdevice`, which is before `node.script` is
even running, so a label always reaches the parameter *after* Push was told what is on
the encoder. Cycling '74 documents that banks "can be modified in real-time to cause
updates on the Push display", and re-asserting the page did make names appear that a
plain write didn't — which is why `refreshPushBankStrip` fires it every time the labels
change. `bank` is that message on its own, for telling a label that never arrived apart
from one sitting behind the cache.

**Every time they *change*.** A relabel whose rendered list matches the last one written
is skipped outright, and the reason is that one rename reaches the encoder twice: once
when the held set is patched from the `apply`, and again when Live's own scene-name
observer answers with a delta saying the same thing. Rewriting the second time pulls the
cache lever on a list Push already has and resets `pushSongIndex` out from under whoever
is turning the encoder. The log still prints on the skipped path — `push: labels
unchanged` — because a silent skip and a broken derive look identical from the Max window,
and telling those two apart is what these lines are for. `diag labels` sets the cache back
to `null` after writing labels of its own, so the next real relabel can't decide it has
nothing to do.

One question the labels left open, and one hardware answered. Where Push truncates a name
longer than `PUSH_LABEL_MAX` is still open — `labels`, with names built to find the edge.

**The non-breaking space is settled, and it was the wrong guess.** `sanitizePushLabel`
used to swap every space in a title for U+00A0, insuring against a space splitting the
atom. Push has no glyph for that character and drew each one as `?`, so a two-word song
reached the display as `Two?Words` — the insurance was more visible than the risk. Labels
now carry their spaces exactly as typed.

That leaves the other half: a plain space has to survive `Max.outlet` as one atom. That's
what `labelspaces` is for now — it writes both forms side by side, so position 2 is the
shipped spelling and position 3 the retired one. Position 2 landing on one detent confirms
it; position 2 splitting across two means the list is one atom too long per space and every
later song is on the wrong detent, which is loud enough to catch immediately.

What Cycling '74 documents about the write itself, and what it doesn't, is in the Push
section of [`../../tools/build-device.ts`](../../tools/build-device.ts).

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

**The new control-bar observer and writes are also unverified in Live.** All seven members
are documented `get, set, observe` on `Song`, and the bridge reports Live's readback rather
than trusting the attempted patch. Still, `lom.ts` has no automated host coverage. Check
tempo, metronome, clip-trigger quantization, Arrangement Record, root note, scale name and
Scale Mode against Live's own Control Bar with the device loaded; a missing
`transport_state` or an unchanged readback is the visible, harmless failure mode.

`record_mode` is the one member of that set with a side effect beyond its own value:
setting it to 1 while the song is rolling starts an Arrangement take immediately. That is
Live's own behavior for the button, and it's why the header's control arms rather than
records — nothing here calls it on the user's behalf.
