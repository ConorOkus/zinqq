---
status: cancelled
priority: p1
issue_id: '349'
tags: [code-review, regression, lifecycle, react, strictmode, pr-160]
dependencies: []
---

# Cancelled scheduler poisons WeakMap → silent persistence failure on remount (PR #160 regression)

## Problem Statement

PR #160 (`fix/weakmap-one-scheduler-per-cm`) caches the scheduler in a
module-level `WeakMap<ChannelManager, Scheduler>`. The cache key is the
`ChannelManager` identity, which `init.ts:217` (`initPromise` dedup) keeps
alive across LdkProvider effect re-mounts. But `SerialPersister.cancel()`
(`serial-persister.ts:99-101`) is a **one-way latch** — once cancelled,
every subsequent `schedule()` returns `Promise.resolve()` (silently no-ops).

Combined with `context.tsx:1431` calling `cmPersistScheduler?.cancel()` in
`teardown()`, the lifecycle is:

1. **Mount #1** → factory creates scheduler S, caches `WeakMap[cm] → S`.
2. **Mount #1 cleanup** (StrictMode dev double-effect, HMR fast-refresh,
   future remount paths) → `teardown()` → `S.cancel()` → `S.cancelled = true`
   forever.
3. **Mount #2** → factory returns cached **dead** S. Every `schedulePersist()`
   from chain-sync, event-drain, peer-timer is now a silent no-op.
4. ChannelManager dirty bit accumulates; on tab close, state is lost.

**This is strictly worse than the original PR #157 problem.** Pre-PR #160,
StrictMode produced two racing schedulers (noisy 409s, but persists landed).
Post-PR #160, StrictMode produces one cancelled scheduler (silent persistence
failure → fund loss on tab close).

**Reachability today:** dev StrictMode every page load, dev HMR every save
on `context.tsx` or imports. Prod: not currently reached because wallet-
takeover transitions to error state and `Restore.tsx:164` does a full
reload — but it's a latent landmine for any future remount path (error-
boundary retry, status flap, React 19 Activity, logout-without-reload).

## Findings

- **kieran-typescript-reviewer P1** (cancel poisons cache)
- **security-sentinel P1** (silent data loss is the worst possible outcome)
- **architecture-strategist P1** (cancel/cache layering hazard)

Three independent reviewers reached the same conclusion. The new test at
`persist-cm.test.ts:330-368` does NOT catch this because it doesn't exercise
the `cancel()` step before observing the second factory call.

**Failing test that proves the bug:**

```ts
it('does NOT return a cancelled scheduler from a previous lifecycle', async () => {
  const cm = makeDirtyCm()
  const ctx = { vssClient: makeVssClient(), cmVersionRef: { current: 0 } }

  const first = createChannelManagerPersistScheduler(cm as never, ctx)
  first.cancel() // simulates effect-cleanup

  const second = createChannelManagerPersistScheduler(cm as never, ctx)
  cm.setDirty()
  await second.schedule()
  expect(ctx.vssClient.putObject).toHaveBeenCalledTimes(1) // FAILS: 0 calls
})
```

## Proposed Solutions

### Option A — Evict from WeakMap inside `cancel()` (smallest fix)

```ts
const scheduler = createSerialPersister(...)
const wrapped: ChannelManagerPersistScheduler = {
  schedule: scheduler.schedule,
  cancel: () => {
    SCHEDULERS_BY_CM.delete(cm)
    scheduler.cancel()
  },
}
SCHEDULERS_BY_CM.set(cm, wrapped)
return wrapped
```

- Pros: ~4 lines, no API changes, restores correctness.
- Cons: subtle; needs the regression test to ride along.
- Effort: Small.
- Risk: Low.

### Option B — Don't cancel scheduler in effect teardown; only on takeover

The whole reason `initPromise` exists is "the node outlives the effect; don't
tear LDK down on StrictMode cleanup." Cancelling the persist scheduler on
every teardown is the same mistake at a smaller scale. Keep `cancel()` only
in the wallet-takeover branch (`context.tsx:1456`).

- Pros: aligns with existing lifecycle philosophy (init.ts:1435-1437 comment).
- Cons: subtle change — the trailing-iteration suppression on real teardown
  was a P1 fix in #338. Need to confirm it's still suppressed via some other
  mechanism (e.g., the `nodeRef.current = null` check at `context.tsx:1440`).
- Effort: Small.
- Risk: Medium (changes lifecycle semantics).

### Option C — Move scheduler to `node` object (#341 Option B, deferred originally)

See companion todo #350. This eliminates the cache entirely — no WeakMap, no
`cancel()`/cache interaction, and restores pattern parity with `known-peers.ts`.

- Pros: structural fix. Eliminates this finding AND #350, #351, #352, #353.
- Cons: bigger refactor; ripples through `init.ts`, `context.tsx`, tests.
- Effort: Medium.
- Risk: Low (changes are cohesive).

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/storage/persist-cm.ts:60,77-85`,
  `src/ldk/storage/serial-persister.ts:99-101`,
  `src/ldk/context.tsx:1431` (cancel call),
  `src/ldk/storage/persist-cm.test.ts` (regression test)
- **Blocks merge of PR #160:** yes

## Acceptance Criteria

- [ ] After `cancel()` + factory re-call with same `cm`, schedule() actually
      persists (the PoC test above passes)
- [ ] No silent no-op path in production lifecycle
- [ ] Regression test added to `persist-cm.test.ts`

## Work Log

_(empty)_

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/160 (closed)
- Original todo: #341 (re-closed by #350)
- Lifecycle reference: `src/ldk/init.ts:217` (initPromise dedup keeps CM alive)
- Lifecycle comment: `src/ldk/context.tsx:1435-1437` ("don't tear LDK down on StrictMode cleanup")

## Cancelled

PR #160 was closed without merging. The structural fix in #350 (scheduler attached to `node` in `init.ts`) eliminates the WeakMap entirely — no cache, so no cancel-poisons-cache hazard. This bug class can no longer happen.
