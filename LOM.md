# The Live Object Model

**Hand-maintained — edit this file directly.** It started as generator output and
stopped being it: the notes below about undocumented members, the docs being wrong, and
what the LOM lacks were all written here by hand, and exist in no other source.
Regenerating over this file would delete them silently, so nothing regenerates it.

After a Live upgrade, `npm run dev:lom-scrape` rescrapes Cycling '74's page to
`node_modules/.cache/lom-scraped.md` and leaves this file alone; diff the two and merge
what the upgrade changed. `git diff --no-index bridge/LOM.md node_modules/.cache/lom-scraped.md`

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
| `take_lanes` / `create_take_lane` | `Track` | Arrangement take lanes. Listed for completeness; nothing here reaches them. |

**Two error strings that are really constraints.** Neither appears on the Cycling '74
page, and both sit in 12.4.3's LiveAPI error block beside `'$1' is not a listenable
device property`:

> `Changes cannot be triggered by notifications.`
> `Changes cannot be triggered during undo or redo.`

**You cannot write to the LOM from inside an observer callback.** Live throws. Reads are
fine, which is what makes the existing dirty-flag-then-`Task` pattern (`onPlayChange`)
the right shape and not merely a tidy one — it's the only legal shape. Anything that
wants to react to a change by *writing* has to defer out of the callback first.

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
- **`group_tracks` in the binary is Push's, not the LOM's, and `ungroup` is a rack
  call.** Both are there under `strings`, and neither groups a track for us.
  `group_tracks` sits 35 lines from `move_scene_call` in a block of `*_call` /
  `*_response` pairs, and the mangled symbol
  `ableton::push_live_model::Song::Message_group_tracks` names its owner outright —
  the same trap as `move_scene_call`, one block over. `ungroup` sits among
  `macro_variations`, `move_into_new_chain` and `DrumRackDevice`: it ungroups a rack's
  chains. **There is no way to put a track into or out of a group from the LOM**, which
  `Track.group_track` being `get` already implied and this confirms from the other side.
- **Duplicate-then-delete cannot reorder tracks**, though it is exactly what reorders
  scenes. The difference is that both halves of the scene trick are addressable:
  `create_scene(index)` puts a blank *anywhere* and `duplicate_clip_to(target)` fills
  *anywhere*. For tracks only the first half exists — `create_audio_track(index)` and
  `create_midi_track(index)` do take a destination — and `duplicate_track(index)` takes
  only *which* track, no destination, so Live drops the copy beside its source.
  Duplicating and deleting the original therefore leaves the copy in the original's
  place: the sequence is order-*preserving*, whatever order you run it in.
  Reconstructing a track into a blank at the right index gets further than it looks —
  `duplicate_clip_to` carries clips across same-type tracks, `move_device` carries the
  devices, and mixer, routing, name and color are all settable — but automation, take
  lanes and Arrangement content have no copy path, and the grouping can't be rebuilt
  per the entry above. Track order is Live's to change; the app follows, because
  `observe` watches `live_set tracks` and re-snapshots on `changed structure`.
- **No aggregate "a clip in this track changed" observable.** There is no way to watch a
  track, a scene, or the set for clip *content*, so anything that wants to know a clip
  moved has to watch per slot — `trackCount × sceneCount` observers — or find the
  affected region some other way. `Track.clip_slots` and `Scene.clip_slots` are
  observable but are **const lists** ("const access to the list of clipslots … for this
  track"), so they fire on list *membership*: `Track.clip_slots` when the scene count
  changes, `Scene.clip_slots` when the track count does. Both are therefore redundant
  with `Song.tracks` / `Song.scenes`. Checked in both sources — the complete `ClipSlot`
  and `Track` docstring blocks in 12.4.3's own table hold nothing else.

  The one partial exception is **group-track slots**, which do aggregate their members:
  `ClipSlot.controls_other_clips` ("true if firing this slot will fire clips in other
  slots") and `ClipSlot.color_index` ("the first clip in the Group Track") are both
  observable, so a grouped set can be watched at `sceneCount × groupCount`. It's lossy —
  a move *within* a group that doesn't change the group's first clip fires nothing — so
  it's a hint about where to re-read, never a fact.
- **No multi-selection list, and selection extent is readable but not observable.**
  There is no `selected_tracks` / `selected_scenes` anywhere in either source.
  `Song.View.selected_track` and `selected_scene` are `get, set, observe` and are the
  Session cursor — Live defines `highlighted_clip_slot` as *"the clip slot, defined via
  the selected track and scene"*. `Track.is_part_of_selection` is **`get` with no
  `observe`**, so the column extent of a selection can be read (one call per track) but
  never watched, and `Scene` has no counterpart at all, so the row extent is unreadable.
  Whether `is_part_of_selection` covers a track under a selected *block of clips* or
  only a selected track *header* is **unverified** — `npm run dev:diag -- sel` settles
  it, and it decides whether a selection-driven resync can cover a rectangle drag.
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
- **No way to read a control surface's session ring — the red box.** It is written,
  never published. `set_session_highlight(track_offset, scene_offset, …,
  include_return_tracks, include_rack_chains)` sits in the binary's `c_instance` block
  beside `set_pad_translation` and `request_rebuild_midi_map` — the interface a MIDI
  Remote Script uses to push state *into* Live. The offsets live in the script's own
  process (`ableton/v2/control_surface/components/session_ring.py`,
  `SessionRingComponent`) and Live does not re-expose them.

  What `control_surfaces N` resolves to is `ControlSurfaceProxy` — "Represents a
  control surface running in a different process. For use by M4L" — whose whole
  surface is `type_name`, `control_descriptions`, `grab_control`, `release_control`,
  `subscribe_to_control`, `unsubscribe_from_control`, `send_value`,
  `fetch_received_values`, `enable_receive_midi`, `fetch_received_midi_messages`. All
  undocumented; no offsets, no ring size. A `ControlDescription` "Describes a control
  present in a control surface proxy" — a pad, an encoder, a button — so the ring
  isn't one, and values flow hardware→you rather than the direction the highlight went.

  **`get_control_names` no longer exists**, so the Live 9/10 docs still circulating for
  it are stale — it is absent from 12.4.3's table entirely, which is a real negative for
  a name this distinctive. `get_control_by_name` *is* present, but in the
  `TMidiRemoteScript` block next to `build_midi_map` and `lock_to_device`: Live's
  internal host interface, not reachable from Max.

  Don't try to infer the ring by watching the surface's own nav buttons. `grab_control`
  *takes* the control from the script, so grabbing the buttons that move the ring stops
  the ring from moving. The only accurate route is a Remote Script in the User Library
  that relays its own offsets out — controller-specific, and a second deployable beside
  the `.amxd`.

## Class index

| class | canonical path | children | properties | functions |
|---|---|---|---|---|
| [`Application`](#application) | `live_app` | 2 | 5 | 6 |
| `Application.View` | `live_app view` | 0 | 2 | 8 |
| `TuningSystem` | `live_set tuning_system` | 0 | 6 | 0 |
| [`Song`](#song) | `live_set` | 9 | 48 | 34 |
| [`Song.View`](#songview) | `live_set view` | 6 | 2 | 1 |
| `GroovePool` | `live_set groove_pool` | 1 | 0 | 0 |
| [`Track`](#track) | `live_set tracks N` | 6 | 40 | 7 |
| [`Track.View`](#trackview) | `live_set tracks N view` | 1 | 2 | 1 |
| [`ClipSlot`](#clipslot) | `live_set tracks N clip_slots M` | 1 | 11 | 7 |
| [`Clip`](#clip) | `live_set tracks N clip_slots M clip` | 1 | 46 | 28 |
| [`Clip.View`](#clipview) | `live_set tracks N clip_slots M clip view` | 0 | 2 | 4 |
| `Groove` | `live_set groove_pool grooves N` | 6 | 0 | 0 |
| `Device` | `live_set tracks N devices M` | 2 | 9 | 1 |
| `Device.View` | `live_set tracks N devices M view` | 0 | 1 | 0 |
| [`DeviceParameter`](#deviceparameter) | `live_set tracks N devices M parameters L` | 0 | 11 | 3 |
| `RackDevice` | — | 5 | 7 | 8 |
| `RackDevice.View` | — | 2 | 2 | 0 |
| `DrumPad` | `live_set tracks N devices M drum_pads L` | 1 | 4 | 1 |
| `Chain` | `live_set tracks N devices M chains L` | 2 | 11 | 1 |
| `DrumChain` | — | 0 | 2 | 0 |
| `ChainMixerDevice` | `live_set tracks N devices M chains L mixer_device` | 4 | 0 | 0 |
| `ShifterDevice` | — | 0 | 2 | 0 |
| `SimplerDevice` | — | 1 | 11 | 6 |
| `SimplerDevice.View` | — | 0 | 1 | 0 |
| `Sample` | `live_set tracks N devices N sample` | 0 | 22 | 6 |
| `WavetableDevice` | — | 0 | 15 | 5 |
| `CompressorDevice` | — | 0 | 4 | 0 |
| `PluginDevice` | — | 0 | 2 | 0 |
| `MaxDevice` | — | 0 | 4 | 3 |
| [`MixerDevice`](#mixerdevice) | `live_set tracks N mixer_device` | 9 | 2 | 0 |
| `Eq8Device` | — | 0 | 3 | 0 |
| `Eq8Device.View` | — | 0 | 1 | 0 |
| `DriftDevice` | — | 0 | 29 | 0 |
| `DrumCellDevice` | — | 0 | 1 | 0 |
| `HybridReverbDevice` | — | 0 | 8 | 0 |
| `MeldDevice` | — | 0 | 4 | 0 |
| `RoarDevice` | — | 0 | 3 | 0 |
| `SpectralResonatorDevice` | — | 0 | 7 | 0 |
| `LooperDevice` | — | 0 | 5 | 11 |
| `DeviceIO` | — | 0 | 5 | 0 |
| [`Scene`](#scene) | `live_set scenes N` | 1 | 10 | 3 |
| [`CuePoint`](#cuepoint) | `live_set cue_points N` | 0 | 2 | 1 |
| `ControlSurface` | `control_surfaces N` | 0 | 0 | 9 |
| `this_device` | `live_set tracks N devices M` | 0 | 0 | 0 |

Most device classes are listed for completeness only. `lom.ts` reaches the documented
MixerDevice → DeviceParameter volume path; that exact subset is expanded below. Members
of every other device class remain one `strings` away if that ever changes.

---

## Song

This class represents a Live Set. The current Live Set is reachable by the root path live_set .

Canonical path: `live_set`

### Children

| child | type | access |
|---|---|---|
| `cue_points` | list of CuePoint | get, observe |
| `return_tracks` | list of Track | get, observe |
| `scenes` | list of Scene | get, observe |
| `tracks` | list of Track | get, observe |
| `visible_tracks` | list of Track | get, observe |
| `master_track` | Track | get |
| `view` | Song.View | get |
| `groove_pool` | GroovePool | get |
| `tuning_system` | TuningSystem | get, observe |

### Properties

| property | type | access | notes |
|---|---|---|---|
| `appointed_device` | Device | get, observe | The appointed device is the one used by a control surface unless the control surface itself chooses which device to use. It is marked by a blue hand. |
| `arrangement_overdub` | bool | get, set, observe | Get/set the state of the MIDI Arrangement Overdub button. |
| `back_to_arranger` | bool | get, set, observe | Get/set/observe the current state of the Back to Arrangement button located in Live's transport bar (1 = highlighted). This button is used to indicate that the current state of the playback differs from what is stored in the Arrangement. Setting this property to 0 will make Live go back to playing the content of the arrangement. |
| `can_capture_midi` | bool | get, observe | 1 = Recently played MIDI material exists that can be captured into a Live Track. See capture_midi. |
| `can_jump_to_next_cue` | bool | get, observe | 0 = there is no cue point to the right of the current one, or none at all. |
| `can_jump_to_prev_cue` | bool | get, observe | 0 = there is no cue point to the left of the current one, or none at all. |
| `can_redo` | bool | get | 1 = there is something in the history to redo. |
| `can_undo` | bool | get | 1 = there is something in the history to undo. |
| `clip_trigger_quantization` | int | get, set, observe | Reflects the quantization setting in the transport bar. 0 = None 1 = 8 Bars 2 = 4 Bars 3 = 2 Bars 4 = 1 Bar 5 = 1/2 6 = 1/2T 7 = 1/4 8 = 1/4T 9 = 1/8 10 = 1/8T 11 = 1/16 12 = 1/16T 13 = 1/32 |
| `count_in_duration` | int | get, observe | The duration of the Metronome's Count-In setting as an index, mapped as follows: 0 = None 1 = 1 Bar 2 = 2 Bars 3 = 4 Bars |
| `current_song_time` | float | get, set, observe | The playing position in the Live Set, in beats. |
| `exclusive_arm` | bool | get | Current status of the exclusive Arm option set in the Live preferences. |
| `exclusive_solo` | bool | get | Current status of the exclusive Solo option set in the Live preferences. |
| `file_path` | symbol | get | The path to the current Live Set, in OS-native format. If the Live Set hasn't been saved, the path is empty. |
| `groove_amount` | float | get, set, observe | The groove amount from the current set's groove pool (0. - 1.0). |
| `is_ableton_link_enabled` | bool | get, set, observe | Enable/disable Ableton Link. The Link toggle in the Live's transport bar must be visible to enable Link. |
| `is_ableton_link_start_stop_sync_enabled` | bool | get, set, observe | Enable/disable Ableton Link Start Stop Sync. |
| `is_counting_in` | bool | get, observe | 1 = the Metronome is currently counting in. |
| `is_playing` | bool | get, set, observe | Get/set if Live's transport is running. |
| `last_event_time` | float | get | The beat time of the last event (i.e. automation breakpoint, clip end, cue point, loop end) in the Arrangement. |
| `loop` | bool | get, set, observe | Get/set the enabled state of the Arrangement loop. |
| `loop_length` | float | get, set, observe | Arrangement loop length in beats. |
| `loop_start` | float | get, set, observe | Arrangement loop start in beats. |
| `metronome` | bool | get, set, observe | Get/set the enabled state of the metronome. |
| `midi_recording_quantization` | int | get, set, observe | Get/set the current Record Quantization value. 0 = None 1 = 1/4 2 = 1/8 3 = 1/8T 4 = 1/8 + 1/8T 5 = 1/16 6 = 1/16T 7 = 1/16 + 1/16T 8 = 1/32 |
| `name` | symbol | get | The name of the current Live Set. If the Live Set hasn't been saved, the name is empty. |
| `nudge_down` | bool | get, set, observe | 1 = the Tempo Nudge Down button in the transport bar is currently pressed. |
| `nudge_up` | bool | get, set, observe | 1 = the Tempo Nudge Up button in the transport bar is currently pressed. |
| `tempo_follower_enabled` | bool | get, set, observe | 1 = the Tempo Follower controls the tempo. The Tempo Follower Toggle must be made visible in the preferences for this property to be effective. |
| `overdub` | bool | get, set, observe | 1 = MIDI Arrangement Overdub is enabled in the transport. |
| `punch_in` | bool | get, set, observe | 1 = the Punch-In button is enabled in the transport. |
| `punch_out` | bool | get, set, observe | 1 = the Punch-Out button is enabled in the transport. |
| `re_enable_automation_enabled` | bool | get, observe | 1 = the Re-Enable Automation button is on. |
| `record_mode` | bool | get, set, observe | 1 = the Arrangement Record button is on. |
| `root_note` | int | get, set, observe | The root note of the scale currently selected in Live. The root note can be a number between 0 and 11, where 0 = C and 11 = B. |
| `scale_intervals` | list | get, observe | A list of integers representing the intervals in Live's current scale (see scale_name and scale_mode). An interval is expressed as the difference between the scale degree at the list index and the first scale degree. |
| `scale_mode` | bool | get, set, observe | Access to the Scale Mode setting in Live. When on, key tracks that belong to the currently selected scale are highlighted in Live's MIDI Note Editor, and pitch-based parameters in MIDI Tools and Devices can be edited in scale degrees rather than semitones. See also root_note, scale_name, and scale_intervals. |
| `scale_name` | unicode | get, set, observe | The name of the scale selected in Live, as displayed in the Current Scale Name chooser. |
| `select_on_launch` | bool | get | 1 = the "Select on Launch" option is set in Live's preferences. |
| `session_automation_record` | bool | get, set, observe | The state of the Automation Arm button. |
| `session_record` | bool | get, set, observe | The state of the Session Overdub button. |
| `session_record_status` | int | get, observe | Reflects the state of the Session Record button. |
| `signature_denominator` | int | get, set, observe |  |
| `signature_numerator` | int | get, set, observe |  |
| `song_length` | float | get, observe | A little more than last_event_time , in beats. |
| `start_time` | float | get, set, observe | The position in the Live Set where playing will start, in beats. |
| `swing_amount` | float | get, set, observe | Range: 0.0 - 1.0; affects MIDI Recording Quantization and all direct calls to Clip.quantize. |
| `tempo` | float | get, set, observe | Current tempo of the Live Set in BPM, 20.0 ... 999.0. The tempo may be automated, so it can change depending on the current song time. |

### Functions

| function | notes |
|---|---|
| `capture_and_insert_scene` | Capture the currently playing clips and insert them as a new scene below the selected scene. |
| `capture_midi` | Parameter: destination [int] 0 = auto, 1 = session, 2 = arrangement Capture recently played MIDI material from audible tracks into a Live Clip. If destinaton is not set or it is set to auto, the Clip is inserted into the view currently visible in the focused Live window. Otherwise, it is inserted into the specified view. |
| `continue_playing` | From the current playback position. |
| `create_audio_track` | Parameter: index Index determines where the track is added, it is only valid between 0 and len(song.tracks). Using an index of -1 will add the new track at the end of the list. |
| `create_midi_track` | Parameter: index Index determines where the track is added, it is only valid between 0 and len(song.tracks). Using an index of -1 will add the new track at the end of the list. |
| `create_return_track` | Adds a new return track at the end. |
| `create_scene` | Parameter: index Returns: The new scene Index determines where the scene is added. It is only valid between 0 and len(song.scenes). Using an index of -1 will add the new scene at the end of the list. |
| `delete_scene` | Parameter: index Delete the scene at the given index. |
| `delete_track` | Parameter: index Delete the track at the given index. |
| `delete_return_track` | Parameter: index Delete the return track at the given index. |
| `duplicate_scene` | Parameter: index Index determines which scene to duplicate. |
| `duplicate_track` | Parameter: index Index determines which track to duplicate. |
| `find_device_position` | Parameter: device [live object] target [live object] target position [int] Returns: [int] The position in the target's chain where the device can be inserted that is the closest possible to the target position. |
| `force_link_beat_time` | Force the Link timeline to jump to Live's current beat time. |
| `get_beats_loop_length` | Returns: bars.beats.sixteenths.ticks [symbol] The Arrangement loop length. |
| `get_beats_loop_start` | Returns: bars.beats.sixteenths.ticks [symbol] The Arrangement loop start. |
| `get_current_beats_song_time` | Returns: bars.beats.sixteenths.ticks [symbol] The current Arrangement playback position. |
| `get_current_smpte_song_time` | Parameter: format format [int] is the time code type to be returned 0 = the frame position shows the milliseconds 1 = Smpte24 2 = Smpte25 3 = Smpte30 4 = Smpte30Drop 5 = Smpte29 Returns: hours:min:sec:frames [symbol] The current Arrangement playback position. |
| `is_cue_point_selected` | Returns: bool 1 = the current Arrangement playback position is at a cue point |
| `jump_by` | Parameter: beats beats [double] is the amount to jump relatively to the current position |
| `jump_to_next_cue` | Jump to the right, if possible. |
| `jump_to_prev_cue` | Jump to the left, if possible. |
| `move_device` | Parameter: device [live object] target [live object] target position [int] Returns: [int] The position in the target's chain where the device was inserted. Move the device to the specified position in the target chain. If the device cannot be moved to the specified position, the nearest possible position is chosen. |
| `play_selection` | Do nothing if no selection is set in Arrangement, or play the current selection. |
| `re_enable_automation` | Trigger 'Re-Enable Automation', re-activating automation in all running Session clips. |
| `redo` | Causes the Live application to redo the last operation. |
| `scrub_by` | Parameter: beats beats [double] the amount to scrub relative to the current Arrangement playback position Same as jump_by , at the moment. |
| `set_or_delete_cue` | Toggle cue point at current Arrangement playback position. |
| `start_playing` | Start playback from the insert marker. |
| `stop_all_clips` | Parameter (optional): quantized Calling the function with 0 will stop all clips immediately, independent of the launch quantization. The default is '1'. |
| `stop_playing` | Stop the playback. |
| `tap_tempo` | Same as pressing the Tap Tempo button in the transport bar. The new tempo is calculated based on the time between subsequent calls of this function. |
| `trigger_session_record` | Parameter: record_length (optional) Starts recording in either the selected slot or the next empty slot, if the track is armed. If record_length is provided, the slot will record for the given length in beats. If triggered while recording, recording will stop and clip playback will start. |
| `undo` | Causes the Live application to undo the last operation. |

## Song.View

This class represents the view aspects of a Live document: the Session and Arrangement Views.

Canonical path: `live_set view`

### Children

| child | type | access |
|---|---|---|
| `detail_clip` | Clip | get, set, observe |
| `highlighted_clip_slot` | ClipSlot | get, set |
| `selected_chain` | Chain | get, set, observe |
| `selected_parameter` | DeviceParameter | get, observe |
| `selected_scene` | Scene | get, set, observe |
| `selected_track` | Track | get, set, observe |

### Properties

| property | type | access | notes |
|---|---|---|---|
| `draw_mode` | bool | get, set, observe | Reflects the state of the envelope/automation Draw Mode Switch in the transport bar, as toggled with Cmd/Ctrl-B. 0 = breakpoint editing (shows arrow), 1 = drawing (shows pencil) |
| `follow_song` | bool | get, set, observe | Reflects the state of the Follow switch in the transport bar as toggled with Cmd/Ctrl-F. 0 = don't follow playback position, 1 = follow playback position |

### Functions

| function | notes |
|---|---|
| `select_device` | Parameter: id NN Selects the given device object in its track. You may obtain the id using a live.path or by using get devices on a track, for example. The track containing the device will not be shown automatically, and the device gets the appointed device (blue hand) only if its track is selected. |

## Track

This class represents a track in Live. It can either be an audio track, a MIDI track, a return track or the master track. The master track and at least one Audio or MIDI track will be always present. Return tracks are optional. Not all properties are supported by all types of tracks. The properties are marked accordingly.

Canonical path: `live_set tracks N`

### Children

| child | type | access |
|---|---|---|
| `clip_slots` | list of ClipSlot | get, observe |
| `arrangement_clips` | list of Clip | get, observe |
| `devices` | list of Device | get, observe |
| `group_track` | Track | get |
| `mixer_device` | MixerDevice | get |
| `view` | Track.View | get |

### Properties

| property | type | access | notes |
|---|---|---|---|
| `arm` | bool | get, set, observe | 1 = track is armed for recording. [not in return/master tracks] |
| `available_input_routing_channels` | dictionary | get, observe | The list of available source channels for the track's input routing. It's represented as a dictionary with the following key: available_input_routing_channels [list] The list contains dictionaries as described in input_routing_channel. Only available on MIDI and audio tracks. |
| `available_input_routing_types` | dictionary | get, observe | The list of available source types for the track's input routing. It's represented as a dictionary with the following key: available_input_routing_types [list] The list contains dictionaries as described in input_routing_type. Only available on MIDI and audio tracks. |
| `available_output_routing_channels` | dictionary | get, observe | The list of available target channels for the track's output routing. It's represented as a dictionary with the following key: available_output_routing_channels [list] The list contains dictionaries as described in output_routing_channel. Not available on the master track. |
| `available_output_routing_types` | dictionary | get, observe | The list of available target types for the track's output routing. It's represented as a dictionary with the following key: available_output_routing_types [list] The list contains dictionaries as described in output_routing_type. Not available on the master track. |
| `back_to_arranger` | bool | get, set, observe | Get/set/observe the current state of the Single Track Back to Arrangement button (1 = highlighted). This button is used to indicate that the current state of the playback differs from what is stored in the Arrangement. Setting this property to 0 will make Live go back to playing the track's arrangement content. For group tracks, this means that all of the tracks that belong to the group and any subgroups will go back to playing the arrangement. |
| `can_be_armed` | bool | get | 0 for return and master tracks. |
| `can_be_frozen` | bool | get | 1 = the track can be frozen, 0 = otherwise. |
| `can_show_chains` | bool | get | 1 = the track contains an Instrument Rack device that can show chains in Session View. |
| `color` | int | get, set, observe | The RGB value of the track's color in the form 0x00rrggbb or (2^16 * red) + (2^8) * green + blue, where red, green and blue are values from 0 (dark) to 255 (light). When setting the RGB value, the nearest color from the track color chooser is taken. |
| `color_index` | long | get, set, observe | The color index of the track. |
| `fired_slot_index` | int | get, observe | Reflects the blinking clip slot. -1 = no slot fired, -2 = Clip Stop Button fired First clip slot has index 0. [not in return/master tracks] |
| `fold_state` | int | get, set | 0 = tracks within the Group Track are visible, 1 = Group Track is folded and the tracks within the Group Track are hidden [only available if is_foldable = 1] |
| `has_audio_input` | bool | get | 1 for audio tracks. |
| `has_audio_output` | bool | get | 1 for audio tracks and MIDI tracks with instruments. |
| `has_midi_input` | bool | get | 1 for MIDI tracks. |
| `has_midi_output` | bool | get | 1 for MIDI tracks with no instruments and no audio effects. |
| `implicit_arm` | bool | get, set, observe | A second arm state, only used by Push so far. |
| `input_meter_left` | float | get, observe | Smoothed momentary peak value of left channel input meter, 0.0 to 1.0. For tracks with audio output only. This value corresponds to the meters shown in Live. Please take into account that the left/right audio meters put a significant load onto the GUI part of Live. |
| `input_meter_level` | float | get, observe | Hold peak value of input meters of audio and MIDI tracks, 0.0 ... 1.0. For audio tracks it is the maximum of the left and right channels. The hold time is 1 second. |
| `input_meter_right` | float | get, observe | Smoothed momentary peak value of right channel input meter, 0.0 to 1.0. For tracks with audio output only. This value corresponds to the meters shown in Live. |
| `input_routing_channel` | dictionary | get, set, observe | The currently selected source channel for the track's input routing. It's represented as a dictionary with the following keys: display_name [symbol] identifier [symbol] Can be set to all values found in the track's available_input_routing_channels. Only available on MIDI and audio tracks. |
| `input_routing_type` | dictionary | get, set, observe | The currently selected source type for the track's input routing. It's represented as a dictionary with the following keys: display_name [symbol] identifier [symbol] Can be set to all values found in the track's available_input_routing_types. Only available on MIDI and audio tracks. |
| `is_foldable` | bool | get | 1 = track can be (un)folded to hide or reveal the contained tracks. This is currently the case for Group Tracks. Instrument and Drum Racks return 0 although they can be opened/closed. This will be fixed in a later release. |
| `is_frozen` | bool | get, observe | 1 = the track is currently frozen. |
| `is_grouped` | bool | get | 1 = the track is contained within a Group Track. |
| `is_part_of_selection` | bool | get |  |
| `is_showing_chains` | bool | get, set, observe | Get or set whether a track with an Instrument Rack device is currently showing its chains in Session View. |
| `is_visible` | bool | get | 0 = track is hidden in a folded Group Track. |
| `mute` | bool | get, set, observe | [not in master track] |
| `muted_via_solo` | bool | get, observe | 1 = the track or chain is muted due to Solo being active on at least one other track. |
| `name` | symbol | get, set, observe | As shown in track header. |
| `output_meter_left` | float | get, observe | Smoothed momentary peak value of left channel output meter, 0.0 to 1.0. For tracks with audio output only. This value corresponds to the meters shown in Live. Please take into account that the left/right audio meters add a significant load to Live GUI resource usage. |
| `output_meter_level` | float | get, observe | Hold peak value of output meters of audio and MIDI tracks, 0.0 to 1.0. For audio tracks, it is the maximum of the left and right channels. The hold time is 1 second. |
| `output_meter_right` | float | get, observe | Smoothed momentary peak value of right channel output meter, 0.0 to 1.0. For tracks with audio output only. This value corresponds to the meters shown in Live. |
| `performance_impact` | float | get, observe | Reports the performance impact of this track. |
| `output_routing_channel` | dictionary | get, set, observe | The currently selected target channel for the track's output routing. It's represented as a dictionary with the following keys: display_name [symbol] identifier [symbol] Can be set to all values found in the track's available_output_routing_channels. Not available on the master track. |
| `output_routing_type` | dictionary | get, set, observe | The currently selected target type for the track's output routing. It's represented as a dictionary with the following keys: display_name [symbol] identifier [symbol] Can be set to all values found in the track's available_output_routing_types. Not available on the master track. |
| `playing_slot_index` | int | get, observe | First slot has index 0, -2 = Clip Stop slot fired in Session View, -1 = Arrangement recording with no Session clip playing. [not in return/master tracks] |
| `solo` | bool | get, set, observe | Remark: when setting this property, the exclusive Solo logic is bypassed, so you have to unsolo the other tracks yourself. [not in master track] |

### Functions

| function | notes |
|---|---|
| `create_audio_clip` | Parameters: file_path [symbol] position [float] Given an absolute path to a valid audio file in a supported format, creates an audio clip that references the file at the specified position in the arrangement view. Prints an error if the track is not an audio track, if the track is frozen, or if the track is being recorded into. The position must be within the range [0., 1576800]. See the ClipSlot.create_audio_clip function if you need to create audio clips in session view instead. |
| `delete_clip` | Parameter: clip Delete the given clip. |
| `delete_device` | Parameter: index Delete the device at the given index. |
| `duplicate_clip_slot` | Parameter: index Works like 'Duplicate' in a clip's context menu. |
| `duplicate_clip_to_arrangement` | Parameters: clip destination_time [double] Duplicate the given clip to the Arrangement, placing it at the given destination_time in beats. |
| `jump_in_running_session_clip` | Parameter: beats beats [double] is the amount to jump relatively to the current clip position. Modify playback position in running Session clip, if any. |
| `stop_all_clips` | Stops all playing and fired clips in this track. |

## Track.View

Representing the view aspects of a track.

Canonical path: `live_set tracks N view`

### Children

| child | type | access |
|---|---|---|
| `selected_device` | Device | get, observe |

### Properties

| property | type | access | notes |
|---|---|---|---|
| `device_insert_mode` | int | get, set, observe | Determines where a device will be inserted when loaded from the browser. 0 = add device at the end, 1 = add device to the left of the selected device, 2 = add device to the right of the selected device. |
| `is_collapsed` | bool | get, set, observe | In Arrangement View: 1 = track collapsed, 0 = track opened. |

### Functions

| function | notes |
|---|---|
| `select_instrument` | Returns: bool 0 = there are no devices to select Selects track's instrument or first device, makes it visible and focuses on it. |

## MixerDevice

The per-track mixer. Better Session View reaches `volume`, `panning` and `sends`; activator state
uses the equivalent inverse of `Track.mute`, while Solo and Arm use their direct Track
properties above.

Canonical path: `live_set tracks N mixer_device`

### Children used here

| child | type | access | notes |
|---|---|---|---|
| `track_activator` | DeviceParameter | get | Exposed by Live, but `lom.ts` uses observable `Track.mute` for this switch. |
| `volume` | DeviceParameter | get | Track volume fader. Master uses `live_set master_track mixer_device volume`. |
| `panning` | DeviceParameter | get | Stereo pan. Master uses `live_set master_track mixer_device panning`. |
| `sends` | list of DeviceParameter | get, observe | One per return track, addressed as `live_set tracks N mixer_device sends L`. |

## DeviceParameter

The writable and automatable parameter object behind volume, pan and sends. The canonical
device parameter path is `live_set tracks N devices M parameters L`; mixer parameters are
also reachable as children of MixerDevice, including the volume paths above.

### Properties used here

| property | type | access | notes |
|---|---|---|---|
| `value` | float | get, set, observe | Internal value between `min` and `max`; track and Master volume report 0–1. Linear to Live's GUI fader, not to displayed dB. |
| `default_value` | float | get | Reset value used for double-click on the compact control. |
| `min` | float | get | Lowest allowed internal value. |
| `max` | float | get | Highest allowed internal value. |
| `is_enabled` | bool | get | 0 when automation, a mapping, remote control or Live prevents direct edits. |

### Functions used here

| function | notes |
|---|---|
| `str_for_value` | Parameter: `value` [float]. Live's formatted representation, used so compact mixer readouts match its dB and pan text. |

## ClipSlot

This class represents an entry in Live's Session View matrix. The properties playing_status , is_playing and is_recording are useful for clip slots of Group Tracks. These are always empty and represent the state of the clips in the tracks within the Group Track.

Canonical path: `live_set tracks N clip_slots M`

### Children

| child | type | access |
|---|---|---|
| `clip` | Clip | get |

### Properties

| property | type | access | notes |
|---|---|---|---|
| `color` | long | get, observe | The color of the first clip in the Group Track if the clip slot is a Group Track slot. |
| `color_index` | long | get, observe | The color index of the first clip in the Group Track if the clip slot is a Group Track slot. |
| `controls_other_clips` | bool | get, observe | 1 for a Group Track slot that has non-deactivated clips in the tracks within its group. Control of empty clip slots doesn't count. |
| `has_clip` | bool | get, observe | 1 = a clip exists in this clip slot. |
| `has_stop_button` | bool | get, set, observe | 1 = this clip stops its track (or tracks within a Group Track). |
| `is_group_slot` | bool | get | 1 = this clip slot is a Group Track slot. |
| `is_playing` | bool | get | 1 = playing_status != 0, otherwise 0. |
| `is_recording` | bool | get | 1 = playing_status == 2, otherwise 0. |
| `is_triggered` | bool | get, observe | 1 = clip slot button (Clip Launch, Clip Stop or Clip Record) or button of contained clip are blinking. |
| `playing_status` | int | get, observe | 0 = all clips in tracks within a Group Track stopped or all tracks within a Group Track are empty. 1 = at least one clip in a track within a Group Track is playing. 2 = at least one clip in a track within a Group Track is playing or recording. Equals 0 if this is not a clip slot of a Group Track. |
| `will_record_on_start` | bool | get | 1 = clip slot will record on start. |

### Functions

| function | notes |
|---|---|
| `create_audio_clip` | Parameter: path Given an absolute path to a valid audio file in a supported format, creates an audio clip that references the file in the clip slot. Throws an error if the clip slot doesn't belong to an audio track or if the track is frozen. |
| `create_clip` | Parameter: length Length is given in beats and must be a greater value than 0.0. Can only be called on empty clip slots in MIDI tracks. |
| `delete_clip` | Deletes the contained clip. |
| `duplicate_clip_to` | Parameter: target_clip_slot [ClipSlot] Duplicates the slot's clip to the given clip slot, overriding the target clip slot's clip if it's not empty. |
| `fire` | Parameter: record_length (optional) launch_quantization (optional) Fires the clip or triggers the Stop Button, if any. Starts recording if slot is empty and track is armed. Starts recording of armed and empty tracks within a Group Track if Preferences->Launch->Start Recording on Scene Launch is ON. If record_length is provided, the slot will record for the given length in beats. launch_quantization overrides the global quantization if provided. |
| `set_fire_button_state` | Parameter: state [bool] 1 = Live simulates pressing of Clip Launch button until the state is set to 0 or until the slot is stopped otherwise. |
| `stop` | Stops playing or recording clips in this track or the tracks within the group, if any. It doesn't matter on which slot of the track you call this function. |

## Clip

This class represents a clip in Live. It can be either an audio clip or a MIDI clip in the Arrangement or Session View, depending on the track / slot it lives in.

Canonical path: `live_set tracks N clip_slots M clip`

### Children

| child | type | access |
|---|---|---|
| `view` | Clip.View | get |

### Properties

| property | type | access | notes |
|---|---|---|---|
| `available_warp_modes` | list | get | Returns the list of indexes of the Warp Modes available for the clip. Only valid for audio clips. |
| `color` | int | get, set, observe | The RGB value of the clip's color in the form 0x00rrggbb or (2^16 * red) + (2^8) * green + blue, where red, green and blue are values from 0 (dark) to 255 (light). When setting the RGB value, the nearest color from the clip color chooser is taken. |
| `color_index` | int | get, set, observe | The clip's color index. |
| `end_marker` | double | get, set, observe | The end marker of the clip in beats, independent of the loop state. Cannot be set before the start marker. |
| `end_time` | double | get, observe | The end time of the clip. For Session View clips, if Loop is on, this is the Loop End, otherwise it's the End Marker. For Arrangement View clips, this is always the position of the clip's rightmost edge in the Arrangement. |
| `gain` | double | get, set, observe | The gain of the clip (range is 0.0 to 1.0). Only valid for audio clips. |
| `gain_display_string` | symbol | get | Get the gain display value of the clip as a string (e.g. "1.3 dB"). Can only be called on audio clips. |
| `file_path` | symbol | get | Get the location of the audio file represented by the clip. Only available for audio clips. |
| `groove` | Groove | get, set, observe | Get/set/observe access to the groove associated with this clip. Available since Live 11.0. |
| `has_envelopes` | bool | get, observe | Get/observe whether the clip has any automation. |
| `has_groove` | bool | get | Returns true if a groove is associated with this clip. Available since Live 11.0. |
| `is_arrangement_clip` | bool | get | 1 = The clip is an Arrangement clip. A clip can be either an Arrangement or a Session clip. |
| `is_audio_clip` | bool | get | 0 = MIDI clip, 1 = audio clip |
| `is_midi_clip` | bool | get | The opposite of is_audio_clip . |
| `is_overdubbing` | bool | get, observe | 1 = clip is overdubbing. |
| `is_playing` | bool | get, set | 1 = clip is playing or recording. |
| `is_recording` | bool | get, observe | 1 = clip is recording. |
| `is_triggered` | bool | get | 1 = Clip Launch button is blinking. |
| `launch_mode` | int | get, set, observe | The Launch Mode of the Clip as an integer index. Available Launch Modes are: 0 = Trigger (default) 1 = Gate 2 = Toggle 3 = Repeat Available since Live 11.0. |
| `launch_quantization` | int | get, set, observe | The Launch Quantization of the Clip as an integer index. Available Launch Quantization values are: 0 = Global (default) 1 = None 2 = 8 Bars 3 = 4 Bars 4 = 2 Bars 5 = 1 Bar 6 = 1/2 7 = 1/2T 8 = 1/4 9 = 1/4T 10 = 1/8 11 = 1/8T 12 = 1/16 13 = 1/16T 14 = 1/32 Available since Live 11.0. |
| `legato` | bool | get, set, observe | 1 = Legato Mode switch in the Clip's Launch settings is on. Available since Live 11.0. |
| `length` | double | get | For looped clips: loop length in beats. Otherwise it's the distance in beats from start to end marker. Makes no sense for unwarped audio clips. |
| `loop_end` | double | get, set, observe | For looped clips: loop end. For unlooped clips: clip end. |
| `loop_jump` | bang | observe | Bangs when the clip play position is crossing the loop start marker (possibly projected into the loop). |
| `loop_start` | double | get, set, observe | For looped clips: loop start. For unlooped clips: clip start. loop_start and loop_end are in absolute clip beat time if clip is MIDI or warped. The 1.1.1 position has beat time 0. If the clip is unwarped audio, they are given in seconds, 0 is the time of the first sample in the audio material. |
| `looping` | bool | get, set, observe | 1 = clip is looped. Unwarped audio cannot be looped. |
| `muted` | bool | get, set, observe | 1 = muted (i.e. the Clip Activator button of the clip is off). |
| `name` | symbol | get, set, observe |  |
| `notes` | bang | observe | Observer sends bang when the list of notes changes. Available for MIDI clips only. |
| `warp_markers` | dict/bang | get, observe | The Clip's Warp Markers as a dict. Observing this property bangs when the warp_markers change. The last Warp Marker in the dict is not visible in the Live interface. This hidden marker is used to calculate the BPM of the last segment. Available for audio clips only. Getting is available since Live 11.0. |
| `pitch_coarse` | int | get, set, observe | Pitch shift in semitones ("Transpose"), -48 ... 48. Available for audio clips only. |
| `pitch_fine` | float | get, set, observe | Extra pitch shift in cents ("Detune"), -50 ... 49. Available for audio clips only. |
| `playing_position` | float | get, observe | Current playing position of the clip. For MIDI and warped audio clips, the value is given in beats of absolute clip time. The clip's beat time of 0 is where 1 is shown in the bar/beat/16th time scale at the top of the clip view. For unwarped audio clips, the position is given in seconds, according to the time scale shown at the bottom of the clip view. Stopped clips have a playing position of 0. |
| `playing_status` | bang | observe | Observer sends bang when playing/trigger status changes. |
| `position` | float | get, observe | Get and set the clip's loop position. The value will always equal loop_start, however setting this property, unlike setting loop_start, preserves the loop length. |
| `ram_mode` | bool | get, set, observe | 1 = an audio clip’s RAM switch is enabled. |
| `sample_length` | int | get | Length of the Clip's sample, in samples. |
| `sample_rate` | float | get | Get the Clip's sample rate. |
| `signature_denominator` | int | get, set, observe |  |
| `signature_numerator` | int | get, set, observe |  |
| `start_marker` | double | get, set, observe | The start marker of the clip in beats, independent of the loop state. Cannot be set behind the end marker. |
| `start_time` | double | get | The start time of the clip, relative to the global song time. For Session View clips, this is the time the clip was started. For Arrangement View clips, this is the offset within the arrangement. The value is in beats. |
| `velocity_amount` | float | get, set, observe | How much the velocity of the note that triggers the clip affects its volume, 0 = no effect, 1 = full effect. Available since Live 11.0. |
| `warp_mode` | int | get, set, observe | The Warp Mode of the clip as an integer index. Available Warp Modes are: 0 = Beats Mode 1 = Tones Mode 2 = Texture Mode 3 = Re-Pitch Mode 4 = Complex Mode 5 = REX Mode 6 = Complex Pro Mode Available for audio clips only. |
| `warping` | bool | get, set, observe | 1 = Warp switch is on. Available for audio clips only. |
| `will_record_on_start` | bool | get | 1 for MIDI clips which are in triggered state, with the track armed and MIDI Arrangement Overdub on. |

### Functions

| function | notes |
|---|---|
| `add_new_notes` | Parameter: dictionary Key: "notes" [list of note specification dictionaries] Note specification dictionaries have the following keys: pitch: [int] the MIDI note number, 0...127, 60 is C3. start_time: [float] the note start time in beats of absolute clip time. duration: [float] the note length in beats. velocity (optional): [float] the note velocity, 0 ... 127 (100 by default). mute (optional): [bool] 1 = the note is deactivated (0 by default). probability (optional): [float] the chance that the note will be played: 1.0 = the note is always played 0.0 = the note is never played (1.0 by default). velocity_deviation (optional): [float] the range of velocity values at which the note can be played: 0.0 = no deviation; the note will always play at the velocity specified by the velocity property -127.0 to 127.0 = the note will be assigned a velocity value between velocity and velocity + velocity_deviation, inclusive; if the resulting range exceeds the limits of MIDI velocity (0 to 127), then it will be clamped within those limits (0.0 by default). release_velocity (optional): [float] the note release velocity (64 by default). Returns a list of note IDs of the added notes. For MIDI clips only. Available since Live 11.0. |
| `add_warp_marker` | Only available for warped Audio Clips. Adds the specified warp marker, if possible. The warp marker is specified as a dict which can have a beat_time and a sample_time key, both associated with float values. The sample_time key may be omitted; in this case, Live will calculate the appropriate sample time to create a warp marker at the specified beat time without changing the Clip's playback timing, similar to what would happen if you were to double-click in the upper half of the Sample Display in Clip View. If sample_time is specified, certain limitations must be taken into account: • The sample time must lie within the range [0, s], where s is the sample's length. The sample_length Clip property helps with this. • The sample time must lie between the left and right adjacents markers' respective sample times (this is a logical constraint). • Within these constraints, there are limitations on the resulting segments' BPM. The allowed BPM range is [5, 999]. |
| `apply_note_modifications` | Parameter: dictionary Key: "notes" [list of note dictionaries] as returned from get_notes_extended. The list of note dictionaries passed to the function can be a subset of notes in the clip, but will be ignored if it contains any notes that are not present in the clip. For MIDI clips only. Available since Live 11.0. Replaces modifying notes with remove_notes followed by set_notes. |
| `clear_all_envelopes` | Removes all automation in the clip. |
| `clear_envelope` | Parameter: device_parameter [id] Removes the automation of the clip for the given parameter. |
| `crop` | Crops the clip: if the clip is looped, the region outside the loop is removed; if it isn't, the region outside the start and end markers. |
| `deselect_all_notes` | Call this before replace_selected_notes if you just want to add some notes. Output: deselect_all_notes id 0 For MIDI clips only. |
| `duplicate_loop` | Makes the loop two times longer by moving loop_end to the right, and duplicates both the notes and the envelopes. If the clip is not looped, the clip start/end range is duplicated. Available for MIDI clips only. |
| `duplicate_notes_by_id` | Parameter: list of note IDs. Or dictionary Keys: note_ids [list of note IDs] as returned from get_notes_extended destination_time (optional) [double/int] transposition_amount (optional) [int] Duplicates all notes matching the given note IDs. Provided note IDs must be associated with existing notes in the clip. Existing notes can be queried with get_notes_extended. The selection of notes will be duplicated to destination_time, if provided. Otherwise the new notes will be inserted after the last selected note. This behavior can be observed when duplicating notes in the Live GUI. If the transposition_amount is specified, the duplicated notes will be transposed by the number of semitones. Available for MIDI clips only. Available since Live 11.1.2 |
| `duplicate_region` | Parameter: region_start [double/int] region_length [double/int] destination_time [double/int] pitch (optional) [int] transposition_amount (optional) [int] Duplicate the notes in the specified region to the destination_time. Only notes of the specified pitch are duplicated or all if pitch is -1. If the transposition_amount is not 0, the notes in the region will be transposed by the transpose_amount of semitones. Available for MIDI clips only. |
| `fire` | Same effect as pressing the Clip Launch button. |
| `get_all_notes_extended` | Parameter: dict (optional) [dict] (See below for a discussion of this argument). Returns a dictionary of all of the notes in the clip, regardless of where they are positioned with respect to the start/end markers and the loop start/loop end, as a list of note dictionaries. Each note dictionary consists of the following key-value pairs: note_id: [int] the unique note identifier. pitch: [int] the MIDI note number, 0...127, 60 is C3. start_time: [float] the note start time in beats of absolute clip time. duration: [float] the note length in beats. velocity: [float] the note velocity, 0 ... 127. mute: [bool] 1 = the note is deactivated. probability: [float] the chance that the note will be played: 1.0 = the note is always played; 0.0 = the note is never played. velocity_deviation: [float] the range of velocity values at which the note can be played: 0.0 = no deviation; the note will always play at the velocity specified by the velocity property -127.0 to 127.0 = the note will be assigned a velocity value between velocity and velocity + velocity_deviation, inclusive; if the resulting range exceeds the limits of MIDI velocity (0 to 127), then it will be clamped within those limits. release_velocity: [float] the note release velocity. It is possible to optionally provide a single [dict] argument to this function, containing a single key-value pair: the key is "return" and the associated value is a list of the note properties as listed above in the discussion of the returned note dictionaries, e.g. ["note_id", "pitch", "velocity"]. The effect of this will be that the returned note dictionaries will only contain the key-value pairs for the specified properties, which can be useful to improve patch performance when processing large notes dictionaries. For MIDI clips only. Available since Live 11.1 |
| `get_notes_by_id` | Parameter: list of note IDs. Provided note IDs must be associated with existing notes in the clip. Existing notes can be queried with get_notes_extended. Returns a dictionary of notes associated with the provided IDs, as a list of note dictionaries. Each note dictionary consists of the following key-value pairs: note_id: [int] the unique note identifier. pitch: [int] the MIDI note number, 0...127, 60 is C3. start_time: [float] the note start time in beats of absolute clip time. duration: [float] the note length in beats. velocity: [float] the note velocity, 0 ... 127. mute: [bool] 1 = the note is deactivated. probability: [float] the chance that the note will be played: 1.0 = the note is always played; 0.0 = the note is never played. velocity_deviation: [float] the range of velocity values at which the note can be played: 0.0 = no deviation; the note will always play at the velocity specified by the velocity property -127.0 to 127.0 = the note will be assigned a velocity value between velocity and velocity + velocity_deviation, inclusive; if the resulting range exceeds the limits of MIDI velocity (0 to 127), then it will be clamped within those limits. release_velocity: [float] the note release velocity. It is possible to optionally provide the argument to this function in the form of a dictionary instead. The dictionary must include the "note_ids" key associated with a list of [int]s, which are the ID values you would like to pass to the function. If you use this method, you can optionally provide an additional key-value pair: the key is "return" and the associated value is a list of the note properties as listed above in the discussion of the returned note dictionaries, e.g. ["note_id", "pitch", "velocity"]. The effect of this will be that the returned note dictionaries will only contain the key-value pairs for the specified properties, which can be useful to improve patch performance when processing large notes dictionaries. For MIDI clips only. Available since Live 11.0. |
| `get_notes_extended` | Parameters: from_pitch [int] pitch_span [int] from_time [float] time_span [float] from_time and time_span are given in beats. Returns a dictionary of notes that have their start times in the given area, as a list of note dictionaries. Each note dictionary consists of the following key-value pairs: note_id: [int] the unique note identifier. pitch: [int] the MIDI note number, 0...127, 60 is C3. start_time: [float] the note start time in beats of absolute clip time. duration: [float] the note length in beats. velocity: [float] the note velocity, 0 ... 127. mute: [bool] 1 = the note is deactivated. probability: [float] the chance that the note will be played: 1.0 = the note is always played; 0.0 = the note is never played. velocity_deviation: [float] the range of velocity values at which the note can be played: 0.0 = no deviation; the note will always play at the velocity specified by the velocity property -127.0 to 127.0 = the note will be assigned a velocity value between velocity and velocity + velocity_deviation, inclusive; if the resulting range exceeds the limits of MIDI velocity (0 to 127), then it will be clamped within those limits. release_velocity: [float] the note release velocity. It is possible to optionally provide the arguments to this function in the form of a single dictionary instead. The dictionary must include all of the parameter names given above as its keys; the associated values are the parameter values you wish to pass to the function. If you use this method, you can optionally provide an additional key-value pair: the key is "return" and the associated value is a list of the note properties as listed above in the discussion of the returned note dictionaries, e.g. ["note_id", "pitch", "velocity"]. The effect of this will be that the returned note dictionaries will only contain the key-value pairs for the specified properties, which can be useful to improve patch performance when processing large notes dictionaries. For MIDI clips only. Available since Live 11.0. Replaces get_notes. |
| `get_selected_notes_extended` | Parameter: dict (optional) [dict] (See below for a discussion of this argument). Returns a dictionary of the selected notes in the clip, as a list of note dictionaries. Each note dictionary consists of the following key-value pairs: note_id: [int] the unique note identifier. pitch: [int] the MIDI note number, 0...127, 60 is C3. start_time: [float] the note start time in beats of absolute clip time. duration: [float] the note length in beats. velocity: [float] the note velocity, 0 ... 127. mute: [bool] 1 = the note is deactivated. probability: [float] the chance that the note will be played: 1.0 = the note is always played; 0.0 = the note is never played. velocity_deviation: [float] the range of velocity values at which the note can be played: 0.0 = no deviation; the note will always play at the velocity specified by the velocity property -127.0 to 127.0 = the note will be assigned a velocity value between velocity and velocity + velocity_deviation, inclusive; if the resulting range exceeds the limits of MIDI velocity (0 to 127), then it will be clamped within those limits. release_velocity: [float] the note release velocity. It is possible to optionally provide a single [dict] argument to this function, containing a single key-value pair: the key is "return" and the associated value is a list of the note properties as listed above in the discussion of the returned note dictionaries, e.g. ["note_id", "pitch", "velocity"]. The effect of this will be that the returned note dictionaries will only contain the key-value pairs for the specified properties, which can be useful to improve patch performance when processing large notes dictionaries. For MIDI clips only. Available since Live 11.0. Replaces get_selected_notes. |
| `move_playing_pos` | Parameter: beats beats [double] relative jump distance in beats. Negative beats jump backwards. Jumps by given amount, unquantized. Unwarped audio clips, recording audio clips and recording non-overdub MIDI clips cannot jump. |
| `move_warp_marker` | Parameters: beat_time [double] beat_time_distance [double] Moves the warp marker specified by beat_time the specified beat time distance. |
| `quantize` | Parameter: quantization_grid [int] amount [double] Quantizes all notes in the clip to the quantization_grid taking the song's swing_amount into account. |
| `quantize_pitch` | Parameter: pitch [int] quantization_grid [int] amount [double] Same as quantize, but only for notes in the given pitch. |
| `remove_notes_by_id` | Parameter: list of note IDs. Deletes all notes associated with the provided IDs. Provided note IDs must be associated with existing notes in the clip. Existing notes can be queried with get_notes_extended. Available since Live 11.0. |
| `remove_notes_extended` | Parameter: from_pitch [int] pitch_span [int] from_time [float] time_span [float] Deletes all notes that start in the given area. from_time and time_span are given in beats. Available since Live 11.0. Replaces remove_notes. |
| `remove_warp_marker` | Parameter: beat_time [float] Removes the warp marker at the given beat time. |
| `scrub` | Parameter: beat_time [double] Scrub the clip to a time, specified in beats. This behaves exactly like scrubbing with the mouse; the scrub will respect Global Quantization, starting and looping in time with the transport. The scrub will continue until stop_scrub() is called. |
| `select_all_notes` | Use this function to process all notes of a clip, independent of the current selection. Output: select_all_notes id 0 For MIDI clips only. |
| `select_notes_by_id` | Parameter: list of note IDs. Selects all notes associated with the provided IDs. Note that this function will not print a warning or error if the list contains nonexistent IDs. Available since Live 11.0.6 |
| `set_fire_button_state` | Parameter: state [bool] If the state is set to 1, Live simulates pressing the clip start button until the state is set to 0, or until the clip is otherwise stopped. |
| `stop` | Same effect as pressing the stop button of the track, but only if this clip is actually playing or recording. If this clip is triggered or if another clip in this track is playing, it has no effect. |
| `stop_scrub` | Stops an active scrub on a clip. |

## Clip.View

Representing the view aspects of a Clip.

Canonical path: `live_set tracks N clip_slots M clip view`

### Properties

| property | type | access | notes |
|---|---|---|---|
| `grid_is_triplet` | bool | get, set | Get/set whether the clip is displayed with a triplet grid. |
| `grid_quantization` | int | get, set | Get/set the grid quantization. |

### Functions

| function | notes |
|---|---|
| `hide_envelope` | Hide the Envelopes box. |
| `select_envelope_parameter` | Parameter: [DeviceParameter] Select the specified device parameter in the Envelopes box. |
| `show_envelope` | Show the Envelopes box. |
| `show_loop` | If the clip is visible in Live's Detail View, this function will make the current loop visible there. |

## Scene

This class represents a series of clip slots in Live's Session View matrix.

Canonical path: `live_set scenes N`

### Children

| child | type | access |
|---|---|---|
| `clip_slots` | list of ClipSlot | get, observe |

### Properties

| property | type | access | notes |
|---|---|---|---|
| `color` | int | get, set, observe | The RGB value of the scene's color in the form 0x00rrggbb or (2^16 * red) + (2^8) * green + blue, where red, green and blue are values from 0 (dark) to 255 (light). When setting the RGB value, the nearest color from the Scene color chooser is taken. |
| `color_index` | long | get, set, observe | The color index of the scene. |
| `is_empty` | bool | get | 1 = none of the slots in the scene is filled. |
| `is_triggered` | bool | get, observe | 1 = scene is blinking. |
| `name` | symbol | get, set, observe | The name of the scene. |
| `tempo` | float | get, set, observe | The scene's tempo. Returns -1 if the scene tempo is disabled. |
| `tempo_enabled` | bool | get, set, observe | The active state of the scene tempo. When disabled, the scene will use the song's tempo, and the tempo value returned will be -1. |
| `time_signature_numerator` | int | get, set, observe | The scene's time signature numerator. Returns -1 if the scene time signature is disabled. |
| `time_signature_denominator` | int | get, set, observe | The scene's time signature denominator. Returns -1 if the scene time signature is disabled. |
| `time_signature_enabled` | bool | get, set, observe | The active state of the scene time signature. When disabled, the scene will use the song's time signature, and the time signature values returned will be -1. |

### Functions

| function | notes |
|---|---|
| `fire` | Parameter: force_legato (optional) [bool] can_select_scene_on_launch (optional) [bool] Fire all clip slots contained within the scene and select this scene. Starts recording of armed and empty tracks within a Group Track in this scene if Preferences->Launch->Start Recording on Scene Launch is ON. Calling with force_legato = 1 (default = 0) will launch all clips immediately in Legato, independent of their launch mode. When calling with can_select_scene_on_launch = 0 (default = 1) the scene is fired without selecting it. |
| `fire_as_selected` | Parameter: force_legato (optional) [bool] Fire the selected scene, then select the next scene. It doesn't matter on which scene you are calling this function. Calling with force_legato = 1 (default = 0) will launch all clips immediately in Legato, independent of their launch mode. |
| `set_fire_button_state` | Parameter: state [bool] If the state is set to 1, Live simulates pressing of scene button until the state is set to 0 or until the scene is stopped otherwise. |

## CuePoint

Represents a locator in the Arrangement View.

Canonical path: `live_set cue_points N`

### Properties

| property | type | access | notes |
|---|---|---|---|
| `name` | symbol | get, set, observe |  |
| `time` | float | get, observe | Arrangement position of the marker in beats. |

### Functions

| function | notes |
|---|---|
| `jump` | Set current Arrangement playback position to marker, quantized if song is playing. |

## Application

This class represents the Live application. It is reachable by the root path live_app .

Canonical path: `live_app`

### Children

| child | type | access |
|---|---|---|
| `view` | Application.View | get |
| `control_surfaces` | list of ControlSurface | get, observe |

### Properties

| property | type | access | notes |
|---|---|---|---|
| `current_dialog_button_count` | int | get | The number of buttons in the current message box. |
| `current_dialog_message` | symbol | get | The text of the current message box (empty if no message box is currently shown). |
| `open_dialog_count` | int | get, observe | The number of dialog boxes shown. |
| `average_process_usage` | float | get, observe | Reports Live's average CPU load. Note that Live's CPU meter shows the audio processing load but not Live's overall CPU usage. |
| `peak_process_usage` | float | get, observe | Reports Live's peak CPU load. Note that Live's CPU meter shows the audio processing load but not Live's overall CPU usage. |

### Functions

| function | notes |
|---|---|
| `get_bugfix_version` | Returns: the 2 in Live 9.1.2. |
| `get_document` | Returns: the current Live Set. |
| `get_major_version` | Returns: the 9 in Live 9.1.2. |
| `get_minor_version` | Returns: the 1 in Live 9.1.2. |
| `get_version_string` | Returns: the text 9.1.2 in Live 9.1.2. |
| `press_current_dialog_button` | Parameter: index Press the button with the given index in the current dialog box. |
