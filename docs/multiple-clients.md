# Multiple clients

What the bridge does and does not guarantee when more than one UI is connected.

## A second client is free

**The bridge holds the current set, so joining costs no walk.** A `snapshot` request is
answered from memory — the snapshot and the `SetModel` read from it — and Live is not
touched at all. That is the difference between a second tab that opens instantly and one
that waits out a walk of every clip slot in the set: ~1s at 243 clips, ~8.8s projected at
848 scenes, all of it on Live's main thread while someone is playing.

`fresh: true` on the request is how a client asks for the walk anyway, and exactly one
thing sends it: the **Snapshot** button. That is a person saying "go and look", which is
the one question held state cannot answer — whether something with *no observer at all*
changed underneath us (`Clip.length`, `Track.fold_state`, another M4L device). Everything
a client does automatically — connecting, coming back to the window, reconciling after a
write — is deliberately **not** fresh. Those are the cases this exists to make free.

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
  reordered by the user, for the same reason. This one asks for a walk of its own
  afterwards: the set is a different shape and knowing it is the bridge's job, so a tab
  opened after a track was added should still be a payload rather than a stall. The
  install echo is *not* this — see the `observe` note below.
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

Dropping does not itself start a walk — the *callers* decide, and they don't agree, on
purpose. A structural change means the set is a different shape and knowing its shape is
this process's job, so that one goes and looks. A write Live took only partly leaves us
unsure rather than behind, and the client that made it is already re-reading; a second
walk from here would be the same read twice. Live's main thread is the scarce resource in
all of it, and until whatever walk is coming lands, Push keeps the song list it already
had — stale rather than wrong-looking-right.

## Multiple clients

The bridge is meant to serve more than one client; the session manager UI is just the
first. Several UI dev servers already share one device today (each proxies `/ws` to the
same bridge), so this is exercised rather than hypothetical.

**Already correct.** `pending` keys by request id and stores the originating socket, so
replies route to the client that asked. Terminal replies (`snapshot`, `applied`,
`palette`) go to the requester; `changed`, `delta`, `deviceState` and `reload` broadcast.
Each client's `BridgeClient` is its own instance, so `lastWireTiming` is per-client.

**Client watches are refcounted**, which they had to become the moment `useBridge` started
following Live. Every watch is one global observer list in `lom.ts`, including the fixed
control-bar list, so a client sending `watch_play 0` on unmount used to stop play state for
every other client too — and a client that closed its tab never sent `off` at all, holding
the watch open forever.
`bridge.ts` keeps a `Set` of sockets per watch kind, releases them on socket close, and
re-arms from that record when the LOM reports ready again after a device reload.

**Two watches belong to the device, and five to whoever is looking.**

`observe` (the set restructured) and `watch_selection` (the Session cursor, which is how a
clip edited in Live reaches the held copy) are how the bridge keeps the set it holds
current. They are armed once when the LOM reports ready and never released, because
**a client connecting or disconnecting must not change what the device knows**. Clients
cannot subscribe to them at all; the messages no longer exist in the protocol.

They used to be client subscriptions, and that was the mistake underneath a long run of
symptoms. Arming `observe` re-installs the `live_set tracks` and `live_set scenes`
observers, and installing a LiveAPI property observer makes Live call back once with the
value it already had. That callback arrives here as `changed structure`, which dropped the
held set and was broadcast to every client as "go and re-walk". So opening the page
invalidated the cache the page was about to read; closing the last tab tore the observers
down entirely and left the bridge blind; and under React StrictMode, which mounts,
unmounts and mounts again, one page load did it twice. The workaround at the time was to
hoist `BridgeProvider` above `App` so a hot update wouldn't re-arm — which treated the
cost as a fact of life rather than a bug.

The remaining five — `watch_play`, `watch_meters`, `watch_status`, `watch_sends`,
`watch_transport` — are viewport concerns. Meters at 30 Hz with nothing on screen is pure
waste, and several install observers per *track*, so a client re-sends `on` to rebuild
them when a snapshot finds a different track count. For those, **`on` is forwarded on
every subscribe and only `off` is edge-triggered**: they answer with a frame, and a client
joining an already-watched stream would otherwise wait for the next change before it had
any state at all. Forwarding costs nothing, because every `watch_*` handler in `lom.ts`
clears or rebuilds before it installs. Sets of sockets rather than counters, so a client
sending `on` twice doesn't need two `off`s to release.

The install echo still happens where `observe` genuinely is armed — once per device start
— so `expectStructureEcho` braces for it there. **Counted and time-boxed together**,
because either alone fails badly: a count alone would silently eat the next real
structural change if Live ever stopped echoing, and a window alone would eat every
structural edit made in the first ten seconds. It also *accumulates* rather than resets,
since two arms can be outstanding before either echo is delivered.

## Nobody walks but the bridge

A client asking for the set is a message and a payload. It never causes a walk except in
one case it cannot avoid — the bridge holds nothing yet — and one the user asked for
explicitly, the **Snapshot** button, which is what `fresh` on the request means.

The staleness backstop moved here for the same reason the watches did. It covers what no
observer can report: properties Live exposes with no `observe` at all (`Clip.length`,
`Track.fold_state`) plus another M4L device or a remote script. Deciding the set has gone
stale, and spending Live's main thread to find out, belongs to the process that owns the
set — not to N tabs each with their own clock, reaching the same conclusion at the same
moment and asking for the same walk. `shouldWalk` is still the same function in `core/`
with the same tests; only the caller moved. Only a walk that was *kept* resets its clock:
one answered but not held proves nothing about what we know now.

**Not yet guaranteed.** Three things to fix before a second *kind* of client exists:

1. **Dict names are fixed, so a request can read another's payload.** The window is
   narrow, not wide: every publish still happens inside one Max message, and `busy()`
   refuses to start anything while a read or a write is running. But between one side
   writing a dict and the other side's `getDict` landing, a second request can overwrite
   it. Per-request names (`bsv_ops_<reqId>`) retire the whole class.

   **The snapshot no longer reads synchronously**, which narrows nothing and widens
   nothing here — it spans many Max messages now, but it publishes in exactly one, and
   `snapJob` holds the guard shut across every tick in between. `finishSnapshot` clears
   it *after* the publish for the reason `finishJob` learned the hard way.
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
