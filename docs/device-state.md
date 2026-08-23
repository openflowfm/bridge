# Device state and the embedded palette

Set-owned configuration in the hidden parameter, and the 70-color table.

## Device state

The default artist, roles and the allowed-color subset live in one versioned JSON object. `bridge.ts`
encodes it as a base64url symbol and sends `device_state_set`; the generated patcher
routes that around `lom.ts` into `pattr openflow-state`. The pattr is a Max for Live Blob
parameter with `parameter_invisible: 1`, so it is Stored Only: Live writes it into the
set but does not expose meaningless automation for it.

The parameter's long name is the identity Live stores the value under, and it said
`bsv-state` before the open[flow] rename. A set saved under the old name presents
nothing under `openflow-state`, so the device comes up as if new — the migration
below runs again, and the next save persists under the new name.

On startup Node sends `device_state_get` explicitly. That timing is important — pattr
may restore before `node.script` has installed its handlers, so relying on the initial
output would intermittently lose state. The patcher bangs pattr and sends the resulting
symbol back as `device_state`.

`saveSetConfig` replaces the naming default and role definitions together because they
are one form; `saveAllowedColors` remains granular because the recoloring workflow edits
it elsewhere. Two clients changing those independent parts cannot overwrite each other
with stale whole-object copies: the bridge merges each change into its current state and
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
