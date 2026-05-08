---
status: ready
priority: p2
issue_id: '340'
tags: [code-review, idb, visibility, channel-manager, pr-157]
dependencies: []
---

# `persistChannelManagerIdbOnly` IDB writes can reorder against scheduler IDB writes

## Problem Statement

`src/ldk/context.tsx:1411` (visibility-hidden handler):

```ts
const handleVisibilityChange = () => {
  if (document.visibilityState === 'hidden' && nodeRef.current) {
    void Promise.all([
      persistChannelManagerIdbOnly(channelManager),
      // ...
    ])
  }
}
```

`persistChannelManagerIdbOnly` (`persist-cm.ts:87`) writes IDB directly with
fresh `cm.write()` bytes. The scheduler also calls `idbPut` (inside
`persistChannelManager`) for the same key.

Race scenario:

1. Scheduler iteration: VSS putObject in-flight; bytes B1 captured.
2. User backgrounds tab → visibilitychange fires.
3. Visibility handler captures B2 (newer, includes events that fired between
   scheduler's `cm.write()` and now). Calls `idbPut` with B2.
4. Scheduler's VSS write returns. Scheduler now calls `idbPut` with B1.
5. `idbPut` opens fresh transactions per call → no defined ordering.
   Last writer by wall-clock wins.
6. If the scheduler's later `idbPut(B1)` resolves _after_ the visibility
   handler's `idbPut(B2)`, IDB ends up with **older** B1.

The architecture-strategist judges this safe because VSS is written first and
the visibility handler always reads the latest CM. But this relies on a
subtle invariant about IDB transaction ordering that isn't documented.
Security-sentinel rates this P2.

## Findings

- security-sentinel P2-4 (concrete race walkthrough).
- architecture-strategist P3 (says "documented invariant suffices").

## Proposed Solutions

### Option A — Single IDB-write queue for `ldk_channel_manager`

Wrap all writes to that key in a small lock so they serialize in submission
order.

```ts
let cmIdbChain: Promise<void> = Promise.resolve()
function queueCmIdbWrite(bytes: Uint8Array): Promise<void> {
  cmIdbChain = cmIdbChain
    .catch(() => undefined)
    .then(() => idbPut('ldk_channel_manager', CM_IDB_KEY, bytes))
  return cmIdbChain
}
```

Both `persistChannelManager` and `persistChannelManagerIdbOnly` use the queue.

- Pros: removes the reorder window entirely.
- Cons: another tiny piece of shared state.
- Effort: Small.
- Risk: Low.

### Option B — Document the invariant

Add prominent comment at `persist-cm.ts:51` and `:87` stating the assumed
ordering. Cheaper but relies on future authors not breaking it.

- Effort: Trivial.
- Risk: Medium (any reorder of the IDB-write step inside
  `persistChannelManager` silently regresses).

### Option C — Visibility handler awaits the scheduler

`if (inFlight) await inFlight; await idbPut(...)`. **Not safe** — visibility
handler has ~tens of ms before tab kill.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/storage/persist-cm.ts`, `src/ldk/context.tsx`
- **Verify:** does `idbPut` (in `src/storage/idb.ts`) already serialize via
  one shared connection? If yes, the race may already be impossible.

## Acceptance Criteria

- [ ] No path can leave IDB at a state older than what was last passed to a write call
- [ ] Test: schedule + visibility-fire interleaving, assert final IDB state == latest CM bytes

## Work Log

### 2026-05-08 — Approved for work

**By:** Claude Triage System

**Actions:**

- Issue approved during triage session
- Status changed from pending → ready

**Learnings:**

- Worth a small IDB-write queue rather than relying on the (undocumented) VSS-first ordering invariant. #348 covers the docs-only fallback if this slips.

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/157
- `src/storage/idb.ts` — check existing transaction model
