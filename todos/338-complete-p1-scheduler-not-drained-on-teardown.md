---
status: complete
priority: p1
issue_id: '338'
tags: [code-review, lifecycle, channel-manager, broadcastchannel, pr-157]
dependencies: []
---

# Scheduler not cancelled/drained on provider teardown — outlives wallet lock

## Problem Statement

The scheduler closure is created at `src/ldk/context.tsx:931-934` when
`initializeLdk()` resolves. Teardown at `:1426-1443` does:

```ts
const teardown = () => {
  cancelled = true
  syncHandle?.stop()
  cleanupEventHandlerFn?.()
  nodeRef.current = null
  // ...
}
```

It does **not** cancel or drain the scheduler. If a persist is in-flight when
the wallet-takeover BroadcastChannel fires (`context.tsx:1449-1459`) or the
user hits Restore (`shutdown` callback):

1. In-flight `putObject` continues against VSS.
2. If `pendingDirty` was set, the IIFE's trailing iteration runs **after** the
   new tab has already taken the wallet lock and started its own persistence.
3. Two tabs writing the same VSS key. The whole point of the BroadcastChannel
   takeover is to prevent this.

## Findings

- architecture-strategist P1.
- The scheduler is structurally a long-lived resource bound to `node`'s
  lifetime, but no teardown hook exists.

## Proposed Solutions

### Option A — Add cancellation, suppress trailing iteration

Scheduler accepts a cancel signal; teardown sets it; trailing iteration is
skipped. In-flight VSS write completes (can't safely abort mid-flight).

```ts
let cancelled = false
return {
  schedule: () => { ... },
  cancel: () => { cancelled = true; pendingDirty = false },
}
// in IIFE: while (pendingDirty && !cancelled)
```

- Pros: minimal diff; preserves "complete the in-flight write" guarantee.
- Cons: in-flight write to VSS may still race with new tab — but window is
  narrow and BroadcastChannel takeover already accepts that.
- Effort: Small.
- Risk: Low.

### Option B — `await scheduler.drain()` in teardown

Make teardown async and await the scheduler. New tab waits for old tab to
finish.

- Pros: cleanest.
- Cons: ripples through teardown callers; teardown was previously sync.
- Effort: Medium.
- Risk: Medium (teardown sync→async is invasive).

### Option C — Attach scheduler to `node`, dispose with node

Move scheduler creation into `initializeLdk` so it's part of the `node`
returned object; teardown disposes it via the same path that disposes the
ChannelManager.

- Pros: lifetime mirrors CM lifetime exactly.
- Cons: changes `node` shape; tests that mock `node` need updating.
- Effort: Medium.
- Risk: Low.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/context.tsx`, `src/ldk/storage/persist-cm.ts`, possibly `src/ldk/init.ts`

## Acceptance Criteria

- [ ] Teardown invokes scheduler cancellation (or drain)
- [ ] After takeover, no further VSS writes from the previous tab's scheduler
- [ ] Test: simulate takeover during pendingDirty=true, assert no second putObject

## Work Log

- 2026-05-08: Implemented Option A. The factory now returns `{ schedule, cancel }` (interface `ChannelManagerPersistScheduler`). `cancel()` flips a `cancelled` flag that suppresses trailing iterations; `schedule()` becomes a no-op once cancelled. The in-flight VSS write is allowed to complete (cannot safely abort mid-flight) but no further work runs. `context.tsx` teardown calls `cmPersistScheduler?.cancel()` before stopping the sync loop, so wallet-takeover via BroadcastChannel can no longer collide with this tab's trailing persist. Added `cancel() suppresses trailing iterations` test.

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/157
- Related: #341 (scheduler-per-CM lifetime), BroadcastChannel takeover at `context.tsx:1449`
