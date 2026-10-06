# AGENTS.md

**This file is the whole startup read.** Everything else is on demand.

[`README.md`](README.md) is an index: a table of topic docs, each pointing at one
self-contained doc and the source it governs. Read the index, then **only the rows that
match what you're changing**. Reading the docs end to end is the wrong default.

| touching | start at |
|---|---|
| `lom.ts`, at all | [`docs/lom-gotchas.md`](docs/lom-gotchas.md) — before any edit |
| "does Live expose X?" | [`LOM.md`](LOM.md) — **look it up, don't guess.** Includes where the published docs are wrong |
| the `.amxd`, the patcher, or the build | [`tools/README.md`](tools/README.md) |
| a wire message | [`@openflow/protocol`](https://github.com/openflowfm/protocol#readme) — add it there first, then handle it in `src/bridge.ts` |
| naming, colors, ordering — anything deserving tests | [`@openflow/core`](https://github.com/openflowfm/core#readme) — that logic does not live here |
| anything a user can see or press | the [wiki](https://github.com/ryangavin/better-session-view/wiki) — see rule 8 |

## Rules

1. **`src/lom.ts` is the only file in the whole suite that touches the Live Object
   Model.** Everything else talks to it through the protocol. The one exception is the
   probe device's patcher, whose `[live.path this_device]` learns its own LOM id
   (`liveId`) to send in `hello`; it makes no other LOM call, and `lom.ts` resolves that id.
2. **`lom.ts` cannot `import` anything** — it compiles as a script, not a module, so
   Max's `[v8]` finds its handlers as top-level globals. Protocol types come from the
   global `OpenFlow` namespace. Adding an import breaks the device silently.
3. **The protocol is coarse-grained** — one message per operation, never per property.
   A full set is tens of thousands of LOM reads.
4. **The device holds the set, and no client may change what it knows.** `bridge.js`
   reads the set once when the LOM is ready, watches Live's structure and Session cursor
   for as long as the device is loaded, and patches what it holds. A client connecting,
   disconnecting, refreshing or hot-reloading must not start, stop or re-arm any of that,
   and must never decide to walk Live — only the Snapshot button does. Two watches are the
   device's (`observe`, `watch_selection`) and six are a viewport's; adding a watch means
   answering which. `watch_chains` is refcounted per *target* rather than per kind, so a
   client releasing it can shrink what Live is watching without turning anything off.
   This was violated for a release and the symptoms looked like six different bugs —
   [`docs/multiple-clients.md`](docs/multiple-clients.md).
5. **Clip color is written as `color_index`**, never raw RGB.
6. **Nothing loads from a CDN, and the server binds `127.0.0.1` only.** This runs on stage.
7. **Don't name things with words that already mean something in a DAW.** `transport`
   is play/stop/record. Same trap: scene, clip, cue, bus, send, return, warp, quantize,
   follow action, slot, take, punch, bounce, freeze. Where a DAW term *is* the right
   word for the actual Live concept, use it precisely and don't overload it.
8. **Whenever feature functionality is added or changed, update the relevant wiki page
   in the same change.** The wiki is the user manual. It is a separate repository and
   needs its own commit and push.
9. **A change to how a feature works updates that feature's topic doc in the same
   commit.** A doc that drifts is worse than one that never existed, because it's
   believed. If a change makes a doc wrong, fix the doc — don't append a note saying so.
10. **Imports use the package specifier with the real TypeScript extension**
    (`@openflow/core/derive.ts`), and so do imports inside this repo (`./x.ts`, never
    `./x.js`). `bridge.ts` is bundled by esbuild, which is what lets it import across the
    package boundary; `ws` is inlined so the shipped device is two files and no
    `node_modules/`.
11. **Every commit made by an agent must include a GitHub-compatible co-author
    trailer naming the agent that actually made it.** Leave a blank line between the
    message and the trailer. Never name an agent that didn't write the commit. For example:

    ```text
    Co-authored-by: Codex <noreply@openai.com>
    ```

    ```text
    Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
    ```

## Before you claim something works

```sh
npm run typecheck     # both halves, tools/ and probe/
npm test              # the probe's analysis tests (probe/test)
npm run build         # bridge.js, lom.js, the .amxd — from a clean tree, as CI does
npm run build:probe   # OpenFlowProbe.amxd, when probe/ changed
npm run qa            # the same, installed as SessionBridge-qa — then reload it in Live
```

`lom.ts` has no automated coverage — it needs Live open with the device loaded — and
**it's the file to suspect first**. If a change touches the LOM, say plainly that it's
unverified rather than implying it was tested. Prefer failure modes that are visible and
harmless (an empty snapshot) over ones that are silent, and add a fallback to the
previously-working path where the new one depends on an atom shape we haven't confirmed.

Live caches a loaded device. The QA build stamps the commit on the device face so you can
tell whether Live is holding what you just built — [`tools/README.md`](tools/README.md).
