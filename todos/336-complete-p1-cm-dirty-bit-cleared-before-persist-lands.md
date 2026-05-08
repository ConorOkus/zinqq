---
status: complete
priority: p1
issue_id: '336'
tags: [code-review, ldk, channel-manager, persistence, vss, pr-157]
dependencies: ['335']
---

# `get_and_clear_needs_persistence()` clears LDK dirty bit before persist lands

## Problem Statement

Both call sites of the scheduler invoke
`channelManager.get_and_clear_needs_persistence()` and only schedule a persist
if it returns `true`:

- `src/ldk/context.tsx:1126-1135` (event drain)
- `src/ldk/sync/chain-sync.ts:230-242` (sync tick)

LDK's contract: when `get_and_clear` returns `true`, the caller has *taken
ownership* of the obligation to persist. The atomic clear means once cleared,
nothing else will re-flag this state mutation.

Today the dirty bit is cleared *immediately* upon scheduling. If the scheduled
persist later fails (combined with #335 dropping the trailing run), there is no
LDK-side mechanism to re-trigger persistence. The next mutation will set the
bit again, but in the meantime the on-disk CM state is stale relative to
in-memory state.

If the user closes the tab in that window: VSS has the prior version, IDB also
has the prior version (because `persistChannelManager` does VSS first then IDB,
both fail/skip on the network exception). Reload boots stale CM → broadcast
old commitment → channel slashing.

## Findings

- security-sentinel P1-2 raised this as the root structural problem.
- This is not just "scheduler bug" — it's that ownership of the dirty bit is
  split between the LDK API contract (atomic clear-on-read) and the scheduler
  (best-effort coalesce). Bridge them carefully.

## Proposed Solutions

### Option A — Move `get_and_clear` inside the scheduler (recommended)

Callers unconditionally invoke the scheduler. The scheduler checks
`cm.get_and_clear_needs_persistence()` *immediately before each iteration's
`cm.write()`*. Then the dirty bit's lifecycle is owned by the single component
that knows whether the persist actually completed.

```ts
inFlight = (async () => {
  do {
    pendingDirty = false
    if (!cm.get_and_clear_needs_persistence() && !forceFirst) return
    forceFirst = false
    try { await persistChannelManager(cm, ctx) }
    catch (err) { pendingDirty = true; throw err }
  } while (pendingDirty)
})()
```

- Pros: single owner; trivially correct dirty-bit semantics; eliminates two
  sites racing on the bit.
- Cons: scheduler API changes — first-time callers may want force-persist
  (e.g., teardown, restore). Add a `force?: boolean` arg.
- Effort: Small–medium.
- Risk: Low.

### Option B — Don't clear; use peek + post-success clear

Replace `get_and_clear` with a peek + explicit clear after persist succeeds.
LDK's API may not expose this — verify before pursuing.

- Effort: depends on LDK API.
- Risk: Medium (may not be supported).

### Option C — Caller-side re-flag on rejection

Both callers already-cleared bit must be set back if persist rejects. But LDK's
API likely doesn't expose a "re-set dirty" call. Probably not viable.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/storage/persist-cm.ts`, `src/ldk/context.tsx`, `src/ldk/sync/chain-sync.ts`
- **LDK API:** verify `get_and_clear_needs_persistence` semantics — is the clear ALWAYS atomic with the read? Can it be peeked?

## Acceptance Criteria

- [ ] Single owner of `get_and_clear_needs_persistence()` (the scheduler)
- [ ] Callers no longer gate on the dirty bit; they call the scheduler unconditionally
- [ ] Test: simulate persist failure, confirm next scheduler call still attempts a fresh persist (dirty signal not lost)

## Work Log

- 2026-05-08: Implemented Option A. `cm.get_and_clear_needs_persistence()` is now called only inside `createChannelManagerPersistScheduler` — once on entry to `schedule()` and once at the top of each IIFE iteration (to fold dirty signals that arrived during a previous iteration's `await`). Both call sites — `context.tsx` event drain and `chain-sync.ts` tick — now invoke `schedule()` unconditionally; the old caller-side `if (channelManager.get_and_clear_needs_persistence())` gates were removed. Combined with #335's `mustRetry` latch, the dirty bit is no longer cleared without a corresponding successful persist or a queued retry.

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/157
- Related: #335 (scheduler swallows trailing intent on throw)
- LDK source: `lightningdevkit` package — `ChannelManager.get_and_clear_needs_persistence`
