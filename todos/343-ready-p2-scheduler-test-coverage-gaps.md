---
status: ready
priority: p2
issue_id: '343'
tags: [code-review, tests, channel-manager, pr-157]
dependencies: []
---

# Scheduler test gaps: rejection recovery, fresh bytes, post-quiesce restart, integration

## Problem Statement

The single new test at `src/ldk/storage/persist-cm.test.ts:212-249` proves the
happy-path coalescing claim, which is good — but several non-obvious behaviors
of the scheduler are not asserted:

1. **Rejection clears `inFlight`**: if iteration 1 throws, can the next call
   start a fresh iteration? The `.finally(() => inFlight = null)` implies yes,
   but no test confirms it. A regression that wedges the scheduler permanently
   after a transient error would ship green.
2. **Trailing iteration uses fresh `cm.write()` bytes**: today the test's
   `makeCm()` returns the same `[1,2,3]` every call. A refactor that hoisted
   `const data = cm.write()` outside the loop would still pass this test
   while shipping stale bytes on the trailing persist.
3. **Post-quiesce restart**: after `Promise.all([first, second, third])`
   resolves, a _new_ `schedulePersist()` must start a _new_ in-flight (i.e.,
   `putObject` is called a 3rd time). Today nothing tests that the singleton
   lock releases correctly.
4. **Integration test missing**: the unit test confirms "given concurrent
   calls to one scheduler, only one write happens at a time" — it does not
   confirm the **wiring** in `LdkProvider` actually routes both call sites
   through the _same_ scheduler instance. A regression where someone passes
   a different scheduler to `startSyncLoop`, or forgets the field (#337),
   would not be caught.

## Findings

- kieran-typescript P2, security-sentinel P3-6, architecture-strategist P3.

## Proposed Solutions

### Option A — Add 3 unit tests + 1 integration test

```ts
// 1. rejection-then-recovery
it('does not stay wedged after a rejected iteration', async () => {
  const putObject = vi.fn()
    .mockRejectedValueOnce(new Error('transient'))
    .mockResolvedValueOnce(1)
  const sched = createChannelManagerPersistScheduler(makeCm(), { vssClient: makeVssClient({ putObject }), cmVersionRef: { current: 0 } })
  await expect(sched()).rejects.toThrow('transient')
  await sched() // fresh attempt
  expect(putObject).toHaveBeenCalledTimes(2)
})

// 2. fresh bytes on trailing iteration
it('re-reads cm.write() on the trailing iteration', async () => {
  const cm = { write: vi.fn() }
  cm.write.mockReturnValueOnce(new Uint8Array([1])).mockReturnValueOnce(new Uint8Array([2]))
  // ... assert vssClient.putObject called with [1] then [2]
})

// 3. post-quiesce restart
it('starts a new iteration after the previous batch settles', async () => { ... })

// 4. integration (chain-sync.test.ts or new file)
it('event-drain and sync-loop share the same scheduler instance', async () => { ... })
```

- Pros: closes regression risk on the trickiest invariants.
- Cons: ~80 LOC of tests.
- Effort: Medium.
- Risk: None.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/storage/persist-cm.test.ts`, possibly new `src/ldk/sync/chain-sync.test.ts`

## Acceptance Criteria

- [ ] Rejection-then-recovery test added
- [ ] Fresh-bytes-per-iteration test added
- [ ] Post-quiesce restart test added
- [ ] Integration test exercising both LdkProvider call sites

## Work Log

### 2026-05-08 — Approved for work (scope reduced)

**By:** Claude Triage System

**Actions:**

- Issue approved during triage session
- Status changed from pending → ready
- 4 of the 5 originally listed gaps were addressed in the P1 fix commit (rejection recovery, post-quiesce, no-op when clean, cancel)

**Remaining scope:**

- Fresh `cm.write()` bytes per iteration test — mutate the mock between iterations and assert `putObject` received both byte sequences in order
- Integration test wiring `startSyncLoop` + `LdkProvider` event-drain through the same scheduler (would catch a regression where someone forgets to pass the field)


## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/157
- Related: #335 (rejection handling), #339 (per-call settle semantics)
