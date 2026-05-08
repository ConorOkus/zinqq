---
status: complete
priority: p1
issue_id: '335'
tags: [code-review, vss, persistence, race-condition, channel-manager, pr-157]
dependencies: []
---

# Scheduler drops `pendingDirty` flag when inner persist throws

## Problem Statement

The new scheduler in `src/ldk/storage/persist-cm.ts:68-75` uses an unguarded
`do/while` inside an async IIFE:

```ts
inFlight = (async () => {
  do {
    pendingDirty = false
    await persistChannelManager(cm, ctx)
  } while (pendingDirty)
})().finally(() => {
  inFlight = null
})
```

If `persistChannelManager` throws (transient VSS error, network blip, IDB
quota), the IIFE rejects and exits the loop **before** checking `pendingDirty`.
The trailing follow-up persist that another caller asked for is silently
dropped. Combined with the dirty-bit-already-cleared finding (#336), this
means a single transient VSS failure can permanently lose channel state on
disk → boot from stale CM on next launch → broadcast old commitment →
counterparty justice → channel funds lost.

## Findings

- security-sentinel P1-1 and kieran-typescript-reviewer P1 both flagged this
  independently.
- `.finally(() => { inFlight = null })` clears the lock so subsequent calls
  can start a new inflight, but the _queued_ trailing persist (the one that
  set `pendingDirty=true`) is never run.
- The chain-sync caller has its own `cmNeedsPersist` retry latch
  (`chain-sync.ts:230`), but the event-drain caller in `context.tsx:1127`
  has no equivalent — its work is simply lost.

## Proposed Solutions

### Option A — Run trailing iteration even on throw, throw last error

```ts
inFlight = (async () => {
  let lastErr: unknown
  do {
    pendingDirty = false
    try {
      await persistChannelManager(cm, ctx)
      lastErr = undefined
    } catch (err) {
      lastErr = err
      // Preserve dirty signal: trailing intent must still run on next iteration
    }
  } while (pendingDirty)
  if (lastErr !== undefined) throw lastErr
})().finally(() => {
  inFlight = null
})
```

- Pros: trailing run guaranteed; failure still surfaces to awaiters.
- Cons: silently retries on hard failures (e.g., bad creds) — could mask issues.
- Effort: Small.
- Risk: Low.

### Option B — Per-call settle promises (proper queue)

Each `schedulePersist()` returns its own promise; the loop pops a batch of
waiters per iteration and resolves/rejects exactly that batch. Pairs with #339.

- Pros: `await schedulePersist()` actually means "my mutation is durable."
- Cons: more code (~25 LOC), needs careful testing.
- Effort: Medium.
- Risk: Low–medium.

### Option C — Re-arm in `.finally`

```ts
.finally(() => {
  inFlight = null
  if (pendingDirty) scheduleChannelManagerPersist()
})
```

- Pros: minimal diff.
- Cons: error from the original IIFE still propagates to all current waiters; the re-arm is fire-and-forget so its failure is unhandled.
- Effort: Trivial.
- Risk: Medium (re-entrancy via finally is subtle).

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/storage/persist-cm.ts`
- **Tests to add:** rejection-then-recovery (see #343)

## Acceptance Criteria

- [ ] Scheduler runs the trailing iteration even when an earlier iteration throws
- [ ] Test: first iteration rejects, scheduler still issues a second putObject before settling
- [ ] Test: scheduler does not stay wedged after a rejection — a fresh `schedulePersist()` after the reject triggers a new putObject

## Work Log

- 2026-05-08: Resolved alongside #336 with a `mustRetry` latch. The scheduler now `throw`s the persist error to the awaiter and sets `mustRetry = true`; the next `schedule()` (next chain-sync tick or event drain) runs the persist regardless of LDK's dirty bit. Combined with #336's "scheduler owns get_and_clear" change, the trailing intent is no longer dropped on transient failure. Added `latches mustRetry on failure` and `does not stay wedged after a rejection` tests in `persist-cm.test.ts`.

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/157
- Related: #336 (dirty bit cleared too early), #339 (per-call settle semantics)
- `docs/solutions/logic-errors/vss-restore-background-persist-race.md`
