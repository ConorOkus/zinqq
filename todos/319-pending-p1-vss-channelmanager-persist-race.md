---
status: pending
priority: p1
issue_id: '319'
tags: [vss, persistence, race-condition, ldk, channel-manager]
dependencies: []
---

# VSS ChannelManager persist race — concurrent putObject calls all 409

## Problem Statement

`persistChannelManager` (`src/ldk/storage/persist-cm.ts:24`) is invoked
fire-and-forget from the event-drain loop in `context.tsx:1122`:

```ts
if (node.channelManager.get_and_clear_needs_persistence()) {
  void persistChannelManager(node.channelManager, cmPersistCtx).catch(...)
}
```

During a JIT channel open + payment claim, events fire in tight bursts
(`ChannelMonitor` updates, `ChannelPending`, `ChannelReady`,
`PaymentClaimable`, `PaymentClaimed`). Each drain re-enters
`persistChannelManager` while the previous call is still in flight at
VSS. They all read the same stale `versionRef.current` and all send
`putObject` with the same expected version. VSS accepts one and 409s
the rest.

The retry path in `persist-cm.ts:38-47` ("re-fetch + retry once") does
not save the situation — by the time the retry refetches, _another_
concurrent caller has already bumped the server version, so the retry
also 409s.

Observed in the JIT-receive flow on 2026-05-07 (logs from successful
30,000 sat receive via Megalith JIT channel):

```
POST /__vss_proxy/vss/putObjects 409 (Conflict)   x ~10
[LDK Context] Failed to persist ChannelManager after events
  VssError: [VSS] Transaction could not be completed due to a possible conflict
```

The wallet stays correct in this incident because IDB still saves the
state and the next idle persist eventually wins. But:

- Every JIT open / claim spams critical-severity errors into the log.
- There is a window where remote VSS lags local IDB. If the user
  switches devices or clears the local browser before the next
  successful persist, the latest ChannelManager state is lost from
  durable remote storage.
- The "critical" severity tag drowns the error log and trains us to
  ignore real issues.

## Findings

- ChannelMonitor persistence already has the right pattern (LDK's own
  `update_id`-keyed retry) and tolerates concurrent calls.
- ChannelManager persistence does **not** — it's a single
  versioned-blob write with optimistic concurrency, with no
  serialization on the client side.
- The "fire and forget" call site in `context.tsx:1122` is the trigger:
  every microtask drain that follows a peer message can launch another
  in-flight persist before the previous resolved.
- Linked memory note (`vss-version-cache-startup-seeding-fix`) covers
  startup version seeding, **not** mid-session concurrent writes.

## Proposed Solutions

### Option A — Single-flight queue with coalesced re-run (recommended)

At most one `putObject` in flight; if more changes arrive while one is
running, set a `pendingDirty` flag and re-run a fresh persist after
the current one completes. Latest-wins semantics, no version
conflicts.

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

Replace the bare `void persistChannelManager(...)` at
`context.tsx:1122` with `void schedulePersist()` (and put the
single-flight state inside the LDK provider closure so it's per-node).

### Option B — Mutex around `persistChannelManager`

Cleaner if we already have a mutex utility, but coalesces less well —
each pending caller waits in line and runs its own `cm.write()` even
when the next one would supersede it. Wastes work; A is strictly
better for this access pattern.

### Option C — Single timer-driven persister

Replace event-drain-triggered persist with a 200ms-tick persister that
checks `get_and_clear_needs_persistence()` and writes if dirty. Dead
simple, but introduces up to 200ms of staleness on the happy path,
which we explicitly chose to avoid at `context.tsx:1120-1132`.

## Recommended Action

**Option A.** Latest-wins queue, no extra latency on the happy path, no
version conflicts during bursts. Same shape as standard "save state to
backend" patterns elsewhere in JS land.

## Technical Details

- **Affected files**:
  - `src/ldk/context.tsx` (call site `~1122`)
  - `src/ldk/storage/persist-cm.ts` (export the scheduler, or wrap the
    existing `persistChannelManager` with the queue)
- **Tests**: extend `src/ldk/storage/persist-cm.test.ts` with a test
  that fires N concurrent `schedulePersist()` calls against a fake
  `VssClient` and asserts:
  - Final server version equals start + 1 (collapsed into one write)
  - OR exactly two writes (one initial, one coalesced follow-up) when
    a change arrives mid-write — depending on timing — but never N.
  - No 409 propagates to the caller's `.catch`.

## Acceptance Criteria

- [ ] Concurrent persist calls during JIT channel open + claim produce
      at most 2 VSS writes (initial + coalesced follow-up), not N.
- [ ] No `[VSS] Transaction could not be completed due to a possible
conflict` errors during a clean JIT receive.
- [ ] Existing `persistChannelManager` semantics preserved for callers
      that legitimately want a one-shot persist (or the scheduler is a
      thin wrapper that delegates to it).
- [ ] `pnpm test` and `pnpm lint` pass.

## Work Log

(Empty)

## Resources

- Brainstorm: `docs/brainstorms/2026-05-07-vss-channelmanager-persist-race-brainstorm.md`
- Related memory note: `vss-version-cache-startup-seeding-fix` (startup,
  not mid-session)
