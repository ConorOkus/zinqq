---
date: 2026-05-07
topic: vss-channelmanager-persist-race
---

# VSS ChannelManager Persist Race — Concurrent Writes All 409

## What We're Investigating

`persistChannelManager` is invoked fire-and-forget from the LDK event
drain loop. During a JIT channel open + payment claim, events fan out
fast enough that multiple persists end up in flight at once, all
reading the same stale `versionRef.current` and all 409'ing at VSS.
The wallet stays correct in practice because IDB saves and a later
idle persist eventually wins, but:

- Every JIT receive logs ~10 "critical" severity errors.
- There is a window where remote VSS is behind local IDB.
- We're training ourselves to ignore VSS errors in the log.

## Reproduction

Receive 30,000 sats via JIT channel (Megalith). Logs show a burst:

```
[LDK Event] OpenChannelRequest: accepted 0-conf from LSP
POST /__vss_proxy/vss/putObjects 409 (Conflict)
[LDK ChannelMonitor] update 0→1
POST /__vss_proxy/vss/putObjects 409 (Conflict)
[LDK ChannelMonitor] update 1→2
POST /__vss_proxy/vss/putObjects 409 (Conflict)
[LDK Event] ChannelPending
[LDK Event] ChannelReady
POST /__vss_proxy/vss/putObjects 409 (Conflict)
[LDK ChannelMonitor] update 2→3
POST /__vss_proxy/vss/putObjects 409 (Conflict)
[LDK Event] PaymentClaimable
[LDK Event] PaymentClaimed
POST /__vss_proxy/vss/putObjects 409 (Conflict)   ...
[LDK Context] Failed to persist ChannelManager after events
  VssError: [VSS] Transaction could not be completed due to a possible conflict
```

Each event triggers `drainEventsAndRefresh` →
`get_and_clear_needs_persistence()` → `void persistChannelManager(...)`.
No serialization between calls.

## Root Cause

`src/ldk/context.tsx:1121-1132` — fire-and-forget invocation:

```ts
if (node.channelManager.get_and_clear_needs_persistence()) {
  void persistChannelManager(node.channelManager, cmPersistCtx).catch(...)
}
```

`src/ldk/storage/persist-cm.ts:24-49` — the function reads
`versionRef.current`, sends one `putObject`, retries once on 409 by
refetching. With N concurrent callers all reading the same version,
N-1 writes 409 and the retry path also 409s because by then yet
another concurrent caller has bumped the server version.

The retry-once strategy is correct for "stale local version vs. server
caught up across restarts" (the case the existing memory note
`vss-version-cache-startup-seeding-fix` covers). It is **not**
sufficient for "N concurrent in-process writers".

## Why This Approach (Recommended Fix)

**Latest-wins single-flight queue**, scoped to ChannelManager
persistence, living inside the LDK provider closure so it's per-node.

```ts
let inFlight: Promise<void> | null = null
let pendingDirty = false

function schedulePersist(): Promise<void> {
  if (inFlight) {
    pendingDirty = true
    return inFlight
  }
  inFlight = (async () => {
    do {
      pendingDirty = false
      await persistChannelManager(cm, ctx)
    } while (pendingDirty)
  })().finally(() => {
    inFlight = null
  })
  return inFlight
}
```

Properties:

- At most one VSS `putObject` in flight per ChannelManager.
- If more changes arrive while one is running, they collapse into
  exactly **one** follow-up persist after the current resolves.
- No 409 conflicts in the steady-state event drain path.
- No added latency on the happy path: first call fires immediately.
- Self-contained inside the persist module — call sites swap
  `persistChannelManager(...)` for `schedulePersist()` and otherwise
  unchanged.

## Key Decisions

- **Scope**: ChannelManager only. ChannelMonitor persistence already
  has the right shape (LDK's `update_id`-keyed retry tolerates
  concurrent calls and keys writes by monitor id).
- **No mutex / queue with N entries**: collapsing to "current + one
  follow-up" matches the access pattern (every event drain wants the
  _latest_ CM state, never an intermediate one).
- **Keep the retry-once path inside `persistChannelManager`** as
  defense for genuine version drift after restart. The single-flight
  queue protects against in-process concurrency; the retry path
  protects against cross-session drift. They compose.
- **Per-node state**: the `inFlight` / `pendingDirty` refs live in the
  `LdkProvider` closure (or are passed via `CmPersistContext`), not
  module globals — so a teardown + reinit doesn't see stale state.
- **Severity downgrade**: once the queue lands, any remaining VSS
  conflict is genuinely surprising. Keep "critical" severity (don't
  downgrade), but the noise should disappear.

## Open Questions

1. **Should `persistChannelManagerIdbOnly` (visibility handler) also
   coalesce?** Probably not — it's a one-shot best-effort write at tab
   teardown, runs once, and IDB has no version conflict semantics.
   Leave as-is.
2. **Does the "fire and forget" contract change?** Callers today
   neither await nor surface success/failure beyond the `.catch` log.
   `schedulePersist()` returns the in-flight promise so an interested
   caller _could_ await — but no current caller needs to, and we
   shouldn't introduce new awaits without a reason.
3. **Test seam**: the existing `persist-cm.test.ts` mocks `VssClient`
   directly. The new queue can be tested by firing N
   `schedulePersist()` calls against the mock and asserting at most
   two `putObject` invocations resolved (initial + coalesced).
4. **Do other VSS-backed objects need the same treatment?** Audit:
   - `vss-version-cache` startup seeding — single read-only path,
     fine.
   - Spendable output descriptors persisted via `persist-spendable.ts`
     (if it exists) — check.
   - Network graph snapshot / RGS state — check.
   - Out of scope for this todo; spawn a follow-up if any are
     similarly fire-and-forget.

## Telemetry / Definition of Done

- Receive a JIT-channel-opening Lightning payment.
- Expect: zero 409s, zero "Failed to persist ChannelManager after
  events" entries in the error log for that flow.
- ChannelMonitor logs unchanged (their persistence path is
  independent).

## References

- Todo: `todos/319-pending-p1-vss-channelmanager-persist-race.md`
- Code:
  - `src/ldk/context.tsx:1121-1132` (call site)
  - `src/ldk/storage/persist-cm.ts:24-49` (function)
  - `src/ldk/storage/persist-cm.test.ts` (existing tests to extend)
- Existing pattern to mirror: ChannelMonitor persistence latest-wins
  semantics inside LDK
- Related (but distinct) prior work: VSS startup version cache
  seeding (`docs/solutions/logic-errors/vss-version-cache-startup-seeding-fix.md`)
