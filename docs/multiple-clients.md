# Multiple clients

What the bridge does and does not guarantee when more than one UI is connected.

## A second client is free

**The bridge holds the current set, so joining costs no walk.** A `snapshot` request is
answered from memory — the snapshot and the `SetModel` read from it — and Live is not
touched at all. That is the difference between a second tab that opens instantly and one
that waits out a walk of every clip slot in the set: ~1s at 243 clips, ~8.8s projected at
848 scenes, all of it on Live's main thread while someone is playing.

`fresh: true` on the request is how a client asks for the walk anyway. Two send it, and
only two: the **Snapshot** button, and the client's staleness backstop. Both are asking
the one question held state cannot answer — whether something with *no observer at all*
changed underneath us (`Clip.length`, `Track.fold_state`, another M4L device). The
automatic walk when a tab connects is deliberately **not** fresh; that case is the one
this exists to make free.

### What keeps it current

Everything that can change the set already passes through this process, so the held copy
is patched from the same signals the clients get, with the same functions from `core/`:

| | held state |
|---|---|
| `delta` from Live | merged — `mergeTrackDelta` for clips by scope, `mergeRows` for scene and track rows, plus tempo and Master color |
| `apply`, all ops taken | patched with `applyOps` / `applySceneOps`, from the batch the request carried |
| `moveClips`, nothing failed | patched with `applyClipMove` |
| everything else below | **dropped** |

The model is rebuilt only when the **scene rows** moved — a delta carrying `sceneRows`, or
an apply carrying `sceneOps`. Everything in a `SetModel` is a function of scene names and
`Scene.tempo`, so a clip-only change cannot alter it, and re-sending the whole song list to
say nothing changed is exactly the chatty design the coarse-grained rule exists to prevent.
When it is rebuilt after a delta it rides along on the broadcast `delta` event; Push's
encoder list is rebuilt from the same model in the same breath.

### Dropped on any doubt at all

A held snapshot that has silently drifted from Live is **far worse than a walk**: the grid
disagrees with Live, with no hint which of the two is lying and nothing to say it happened.
A walk is slow and visible. So every uncertain case takes the walk:

- **A `delta` whose `prevRev` doesn't match.** A message was missed and there is no way to
  know what was in it.
- **An `apply` where `applied !== total`.** Live answers with counts and never says *which*
  ops it skipped, so the patch would be a guess. The client reasons identically.
- **A `moveClips` with any failure.** `lom.ts` skips the whole delete pass, so the set holds
  both copies — a state the plan doesn't describe.
- **A write whose request is no longer in `pending`.** Without the batch there is nothing to
  patch with.
- **`move` and `addScenes`, always.** Both renumber the set; that isn't a patch, it's a
  different set. Each already broadcasts one structural change and asks for a walk of its
  own, which restores the held copy.
- **`changed structure` from Live's own observer** — a track or scene added, removed or
  reordered by the user, for the same reason.
- **The LOM reporting ready again.** `rev` is a counter inside `lom.ts` and a reloaded
  device starts it at zero, so anything held is from a sequence that no longer runs.

One more, and it is the one that isn't obvious: **a walk that started before an
invalidation is answered but not held.** `snapshot()` runs inside one Max message, but a
scene move is a chunked `Task`, so a walk can land between two chunks and read a set that
is halfway rearranged. Dropping on `move_done` doesn't cover it — the drop happens first
and the stale payload arrives afterwards with nothing left to say it was stale. Every walk
records `heldGeneration` when it starts and only becomes the held set if that number hasn't
moved; the client that asked still gets its answer, and re-reads on the structural change
that follows. Push isn't relabelled from one either.

Dropping deliberately does **not** start a walk of its own. Live's main thread is the scarce
resource, and a walk nobody asked for could land mid-performance; the next client request
pays for it instead. Until then Push keeps the song list it already had, which is stale
rather than wrong-looking-right.

## Multiple clients

The bridge is meant to serve more than one client; the session manager UI is just the
first. Several UI dev servers already share one device today (each proxies `/ws` to the
same bridge), so this is exercised rather than hypothetical.

**Already correct.** `pending` keys by request id and stores the originating socket, so
replies route to the client that asked. Terminal replies (`snapshot`, `applied`,
`palette`) go to the requester; `changed`, `delta`, `deviceState` and `reload` broadcast.
Each client's `BridgeClient` is its own instance, so `lastWireTiming` is per-client.

**Watches are refcounted**, which they had to become the moment `useBridge` started
following Live. Every watch is one global observer list in `lom.ts`, including the fixed
control-bar list, so a client sending `watch_play 0` on unmount used to stop play state for
every other client too — and a client that closed its tab never sent `off` at all, holding
the watch open forever.
`bridge.ts` keeps a `Set` of sockets per watch kind, releases them on socket close, and
re-arms from that record when the LOM reports ready again after a device reload.

**`on` is always forwarded and only `off` is edge-triggered**, which looks like a bug and
isn't. `watch_play`, `watch_meters` and `watch_sends` install observers per *track* (and
meters also on Master), so a client re-sends `on` to rebuild them when a snapshot finds a
different track count; suppressing that because another client already held the watch
would leave the observers addressing a set that no longer exists. Forwarding it costs
nothing, because every `watch_*` handler in `lom.ts` clears or rebuilds before it installs.
Sets rather than counters, so a client sending `on` twice doesn't need two `off`s to release.

**Not yet guaranteed.** Three things to fix before a second *kind* of client exists:

1. **Dict names are fixed, so a request can read another's payload.** The window is
   narrow, not wide: `lom.ts` reads and publishes synchronously inside one Max message,
   and `apply` refuses to start while a job is running. But between one side writing a
   dict and the other side's `getDict` landing, a second request can overwrite it —
   and `finishJob` clears `job` *before* publishing the result, reopening the guard
   early. Per-request names (`bsv_ops_<reqId>`) retire the whole class.
2. **`apply` rejects instead of queueing.** `if (job) return fail(reqId, 'apply already
   in progress')`. Fine for one client; for two, the second just gets an error and has
   to retry. The chunked `Task` already provides the yield points a FIFO queue needs.
3. ~~**`snapshot` doesn't coalesce.**~~ **Fixed — `snapshot` is single-flight.** A request
   arriving while a walk is running joins it rather than starting a second, and the one
   payload is sent to each joiner stamped with **its own** request id, because that id is
   what resolves the waiter at the other end. Progress fans out to joiners too, so they
   see a moving bar rather than a still modal.

   It had no guard at all, which was survivable while it took N people pressing a button
   at the same moment — and stopped being so once the app followed Live, because one
   structural change broadcasts `changed structure` and every connected client answers by
   re-walking, at ~950ms each, serialized on Live's main thread.

   **Every path that ends a walk must clear the flight**, `snapshot_done` and `err` alike.
   A flight left standing after a walk that errored collects joiners forever and answers
   none of them, and every later request queues behind a walk that is no longer running —
   a worse failure than the one that started it. `takeFlight(reqId)` is the single place
   that closes one out.

   Single-flight is now the *walk* path only — held state answers most requests before
   it is reached. It still matters, because the requests that do walk arrive together:
   one structural change sends every connected client for a fresh read at the same moment.

   A time-based reuse window was considered here once and rejected, on the grounds that
   serving a set from memory risks serving one that changed with no event to say so. What
   changed is that the memory is no longer a *cache with an age* — it is maintained state,
   patched by every signal that can change the set and dropped the moment one of them
   can't be applied. Age was never the right question; provenance is.

   Related and narrower: **`bsv_delta` is a fixed dict name like the rest**, and a delta
   is pushed rather than requested, so two flushes 100ms apart could in principle have
   the second overwrite the dict before `bridge.ts`'s `await Max.getDict` lands. The
   failure is a garbled delta rather than a wrong grid — `prevRev` won't line up and the
   client re-walks — but it's one more instance of item 1.

`changed` still carries only a `kind`, so it remains a full re-read for the receiver —
but that is now the *structural* path only, where re-reading is the honest answer because
every index changed meaning. Content changes travel as `delta`, which carries its scope
and its `rev`, and that is what makes following Live cheap rather than merely correct.
See *Following Live* below.

### A structural job of ours mutes the burst it causes

`add_scenes` and `move` both create and delete scenes, and **every one of those trips the
`live_set scenes` observer**. Unmuted that is one `changed structure` per scene touched,
each of which sends every connected client on a full walk — of a set that is halfway
through being rearranged. Reading a set mid-move is worse than reading it late.

So `structuralJob` mutes the outward message for the duration and Node emits exactly one
structural event after the terminal result. The index-addressed state — the id cache, the
dirty set, the cursor's previous position — is still dropped on every callback; it is only
the message that waits. The mute outlives the job by 100ms, because Live may deliver the
last callbacks just after the final `create_scene` / `delete_scene` returns.

**A stuck mute is silent and permanent**, so every path out of `move` releases it,
including the catch that runs when the throw lands between setting it and scheduling the
task.

`move_done` broadcasts `changed structure`, **not `changed moved`**. The client re-walks on
`structure` and only logs `moved`, so the old kind announced the danger to a handler that
did nothing about it — what actually recovered other clients was the burst, mid-move. The
UI's `moveScenes` no longer asks for its own walk either; the one broadcast drives the
re-read for the client that moved and everyone else, the way `addScenes` already worked.
