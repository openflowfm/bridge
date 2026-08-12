# Multiple clients

What the bridge does and does not guarantee when more than one UI is connected.

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

   A short reuse window on top of this was considered and dropped. It would have to live
   in `bridge.ts`, which deliberately imports nothing from the repo so it can emit to a
   flat file outside its own `rootDir` — so the rule could not go in `core/` where it
   would have tests. Single-flight already absorbs the storm it was aimed at, and serving
   a set from memory trades that for the risk of serving one that changed with no event
   to say so. Not a good trade for what was left.

   Related and narrower: **`bsv_delta` is a fixed dict name like the rest**, and a delta
   is pushed rather than requested, so two flushes 100ms apart could in principle have
   the second overwrite the dict before `bridge.ts`'s `await Max.getDict` lands. The
   failure is a garbled delta rather than a wrong grid — `prevRev` won't line up and the
   client re-walks — but it's one more instance of item 1.

`changed` still carries only a `kind`, so it remains a full re-walk for the receiver —
but that is now the *structural* path only, where a re-walk is the honest answer because
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
