# What ships, and loading it in Live

The two compile targets and why they differ, what actually ships, and how to load the device.

## What actually ships

Three files, and the user should only ever have to hold one of them:

```
SessionBridge.amxd    the device
bridge.js             bundled — ws inlined
lom.js                the [v8] script
```

`npm run build:bridge` runs [`../tools/build-bridge.ts`](../../tools/build-bridge.ts),
which esbuilds `src/bridge.ts` into a single self-contained `bridge.js`. That's what
removes `node_modules/` from the shipped folder — a Live device is something people
download and drag, not a directory tree they're expected to keep together.

**It used to carry the session manager as well**, base64'd into the bundle by a `define`:
595 kB of it, three quarters of the file, parsed by Node inside Live's process on every
device load. set[flow] is a desktop app now, so `bridge.js` is ~204 kB and the device
serves nothing at all — a browser pointed at `:17800` gets one sentence saying so.

Two things are deliberately left external: **`max-api`**, which Max itself provides and
which cannot be bundled, and **`bufferutil` / `utf-8-validate`**, `ws`'s optional native
speedups that it `require`s inside a `try` and does without.

**`npm run dev` does not use the bundler.** It keeps `tsc --watch`, which is faster —
and now that nothing is inlined, that is the only difference between the two paths.

The end goal is **one file**: Live's Freeze button inlines a device's dependencies into
the `.amxd` itself, which is how a 2 MB single-file device on maxforlive.com works. See
[`../tools/README.md`](../../tools/README.md) for the container format and how to read one
back. Whether freeze reaches `node.script`'s file the way it reaches `[js]`/`[v8]`
scripts is **unverified** — check it with `node tools/amxd.ts inspect` on a frozen build.

## Loading it in Live

1. Drop `SessionBridge.amxd` onto any track. It's an audio effect with a
   `plugin~ → plugout~` passthrough, so it's inert on the signal path — the Master
   track is a fine home.
2. Wait for the status to read `No connections`, then run `npm run set` — it should go
   to `1 connection` as the app attaches.

| status | means |
|---|---|
| `Starting…` | patcher loaded, Node hasn't booted |
| `Waiting for Live` | Node is listening, LOM handshake hasn't completed |
| `No connections` | serving, nothing attached — the resting state |
| `1 connection` / `3 connections` | that many clients are on the socket |

The count is deliberately the headline: whether the device reached Live is true within a
frame of it loading and says nothing, whereas whether a browser is attached — and how
many tabs are quietly fighting over the same set — is the thing a glance at the rack
can't otherwise tell you.

Stuck on either of the first two? **Options ▸ Max ▸ Open Max Window** — that's where
every error and every timing line lands.

### Which build is that?

`npm run qa` installs into the User Library as `SessionBridge-qa`, and a device installed
to be driven should be able to say which build it is without being taken apart. So a QA
build stamps the footer — `open[flow] 0.1.0 · qa a1b2c3d`, the short commit, with a
trailing `*` when it was built from a tree with uncommitted changes — and titles itself
*Session Bridge (QA)* in Live's browser and Info View. A release build carries neither.

**Live caches a loaded device**, so the stamp is also the answer to the question that
follows from that: reload the device and read the footer, and you know whether Live picked
up what you just built. See [`../../tools/README.md`](../../tools/README.md) for what the
flag does and does not touch — the device's *name* is never one of them.

**Keep the three files together.** The device resolves `bridge.js` and `lom.js`
relative to its own location, so load the `.amxd` from this repo rather than copying it
into the User Library alone. This is the constraint freezing is meant to remove — see
*What actually ships*.

Set-owned configuration is a hidden Blob parameter in the device, so Live saves it in
the `.als` and it moves wherever the set moves. Replacing the source folder costs it
nothing. An older `bsv.json` or `roles.json` is read once when an empty device migrates;
new writes never create a sidecar file.

Only one copy of the device can run at a time — they'd fight over port 17800. A
second instance posts a warning rather than crashing. `OPENFLOW_PORT` overrides.

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
  a global `OpenFlow` namespace rather than a module, and why atom-parsing logic is
  duplicated into `core/src/lomAtoms.ts` so it can be unit-tested.

**`bridge.ts` compiles to CommonJS**, because Node for Max injects `max-api` as a CJS
module and runs the emitted file directly.

`lom.ts` still emits into `bridge/` with `rootDir: "src"` — Max's `[v8]` loads
`bridge/lom.js` directly, and it can never import anything regardless (see above).
`bridge.ts` does not: it's bundled by esbuild instead — `tools/build-bridge.ts` for the
shipped build, `tools/dev-bridge.ts` for the dev watch loop — specifically so it can
import across the `core/` package boundary (the song list Push shows needs `derive()`).
Bundling doesn't care where an import lives, which is what made that possible;
`bridge/tsconfig.node.json` is typecheck-only now, and nothing asks `tsc` to emit
`bridge.ts` at all. It still reads protocol types off the global `OpenFlow` namespace rather
than importing `protocol/` directly — nothing forces that anymore, it's just how it's
always been done here, not a constraint left over from `rootDir`.

Compiling `lom.ts` into this folder *improves* the dev loop for that half:
`autowatch = 1` watches the emitted `lom.js`, so `[v8]` only reloads on a successful
compile. A successful reload resets all of `lom.js`'s globals without reloading the Max
device, so the patcher holds an initialization latch outside the script: `lom.js` emits
a private `boot` from `loadbang`, and the patcher replays `init` only if
`live.thisdevice` has already completed. `bridge.ts`'s dev loop gets the same
successful-build-only property from `tools/dev-bridge.ts`'s esbuild watcher —
`node.script @watch 1` reloads only when it writes a new `bridge/bridge.js`.
