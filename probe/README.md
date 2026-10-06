# probe/

`OpenFlowProbe.amxd`: a Max for Live audio effect that measures the audio passing
through it and reports to the SessionBridge device in the same set. **The audio is not
changed.** Drop it anywhere in a chain; it hears the signal at that point, after the
devices before it and before the track's volume and pan.

It measures nothing until the bridge asks. A probe sitting in a set costs one comparison
per sample. While it's listening it runs about 100 biquads and 100 multiply-adds per
sample: comfortable on a live set, but not free. Don't leave forty of them listening.

## What it measures

Everything is cumulative over one *listening pass*, from the bridge's `listen … 1` to its
`listen … 0`. The fields are `ProbeReport` in
[`@openflow/protocol`](https://github.com/openflowfm/protocol) (`global.d.ts`):

| field | how |
|---|---|
| `lufsIntegrated` | ITU-R BS.1770-4: K-weighting, 400 ms blocks every 100 ms, the −70 LUFS absolute and −10 LU relative gates. Exact: every gating block is kept. `null` until a block passes the absolute gate |
| `lufsShortTermMax` | the loudest 3 s window, updated every 100 ms. `null` for the first 3 s |
| `loudnessRange` | EBU Tech 3342: P95 − P10 of short-term loudness after the −70 / −20 LU gates, from a 0.1 LU histogram. `null` until 30 short-term values pass both gates |
| `truePeakDb` | 4× polyphase interpolation (a 47-tap Kaiser-windowed sinc, padded to 48, designed in `truepeak.ts`), and never below the sample peak. A steady tone reads within ±0.2 dB up to 0.8×Nyquist. A single isolated crest can fall between two 4× points and under-read by up to 20·log10(cos(π·f / 4fs)). That is −0.43 dB at 0.8×Nyquist and under 0.1 dB below fs/6. The loss comes from the 4× rate, not the filter: BS.1770 accepts the same under-read |
| `samplePeakDb`, `rmsDb`, `overSamples`, `dcOffset`, `correlation` | straight from per-block sums. `rmsDb` is plain 10·log10 of the mean square, so a full-scale sine reads −3.01 |
| `bands` | 31 ISO third-octave bands, 20 Hz to 20 kHz, on (L+R)/2. Each is a 6th-order Butterworth bandpass. Each band has `meanDb` (power mean), plus `floorDb` and `peakDb`, the ~10th and ~95th percentiles of its 100 ms level, from 0.5 dB histograms |

Every dB value is clamped at −150. Every report goes out as a JSON-safe dict.

## How it is built

`node --disable-warning=ExperimentalWarning tools/build-probe.ts` (`npm run build:probe`)
writes three files, all generated and gitignored:

- `probe/OpenFlowProbe.amxd`
- `probe/OpenFlowProbe.maxpat`, the same patcher, to open in Max
- `probe/probe.js`

`npm run install:probe` copies the device and `probe.js` into
`User Library/Max for Live/OpenFlowProbe-qa/`. Max finds `probe.js` beside the device,
so the two travel together, as SessionBridge's scripts do.

```
plugin~ ─> gen~ ─> plugout~          gen~: per-sample work only; writes 100 ms blocks to a buffer~ ring
              ▲         │
   params ────┘         ▼
          v8 probe.js                reads the ring 10×/s, gates, takes percentiles, sends reports
```

| file | what |
|---|---|
| `src/layout.ts` | the two buffer~s gen~ and v8 share: the stats ring and the coefficients. Every offset lives here |
| `src/genexpr.ts` | **generates the gen~ codebox text** from the layout |
| `src/reference.ts` | the same codebox in TypeScript, statement for statement, so tests can run it. Change one, change the other |
| `src/bands.ts`, `kweight.ts`, `truepeak.ts`, `biquad.ts` | filter design: coefficients for whatever rate Live runs at |
| `src/coefficients.ts` | packs them in the layout's order |
| `src/accumulator.ts` | blocks → `ProbeReport`: gating, short-term, LRA, histograms |
| `src/device.ts` | the v8 runtime: key, the bridge messages, polling the ring, reports. Host-independent |
| `src/main.ts` | the bundle entry. `tools/build-probe.ts` appends the Max glue, the only place Max's globals are named |

Two things are deliberate:

- **Coefficients cross as float32 hi/lo pairs.** buffer~ is float32, which moves a
  20 Hz band at 192 kHz by several percent. gen~ adds each pair back into a 64-bit
  `Data` once, when v8 bumps `coefgen`.
- **Per-device buffer~ names reach gen~ through attributes.** The codebox can't contain
  `---`, so `[gen~ @stats ---openflow-probe-stats @coef ---openflow-probe-coef]` rebinds
  its two `Buffer`s to this device's own buffer~s.

## Talking to the bridge

These are global sends, deliberately without `---`. Every probe hears every message and
ignores the ones that aren't its own.

| direction | message |
|---|---|
| probe → `openflow-probe-out` | `hello <key> <liveId>` on load and on every `who`; `report <key> <pass> <final 0\|1> <dictName>`; `bye <key> <liveId>` on unload |
| `openflow-probe-in` → probe | `who`; `listen <key> <pass> <1\|0>`; `rekey <liveId> <newKey>` |

- **The key** is random (`p` plus 11 base-36 characters, so Max never reads it as a
  number). It is made on first load and stored with `pattr openflow-probe-key`, a Stored
  Only Blob parameter, so it persists in the set. A duplicated probe arrives with the
  same key and a different `liveId`, which is what `rekey` is for.
- **`liveId`** comes from `[live.thisdevice] → [live.path this_device]`. That is the
  device's only LOM read.
- **`listen 1`** resets and starts a pass, even mid-pass. **`listen 0`** stops only the
  current pass. The final report follows about 200 ms later, once gen~ has flushed the
  last partial block.
- **Reports** go about once a second. Each is a uniquely named dict
  (`openflow-probe-<key>-<liveId>-<n>`). The liveId keeps a duplicate that still shares
  its original's key from writing the same dict. The last eight stay alive, for the
  bridge to read late.
- **`listen 1` while a pass is stopping** first sends that pass's final report, with
  whatever reached the ring, and only then starts the new pass.

## Tests

```sh
node --test probe/test/            # dsp, accumulator, device, e2e
npx tsc -p probe/tsconfig.json     # the probe's own typecheck
```

The end-to-end tests push known signals through the coefficients, the codebox mirror
and the accumulator:

- a 1 kHz stereo sine at −20 dBFS reads −20 LUFS at 44.1, 48 and 96 kHz;
- EBU Tech 3341 case 3 gates to −23.0;
- Tech 3342 case 1 gives 10 LU of range;
- pink noise is flat across the bands within ±1.5 dB;
- an fs/4 sine at 45° shows a true peak 3 dB over its sample peak.

**What the tests can't cover is gen~ itself.** The codebox is checked against its
TypeScript mirror only by review, so check it in Live after any change to `genexpr.ts`.
