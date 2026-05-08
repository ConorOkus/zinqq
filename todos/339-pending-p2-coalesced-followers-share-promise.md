---
status: pending
priority: p2
issue_id: '339'
tags: [code-review, semantics, channel-manager, pr-157]
dependencies: ['335']
---

# Coalesced followers share the same promise — `await schedule()` doesn't mean "my state is durable"

## Problem Statement

`src/ldk/storage/persist-cm.ts:62-65`:

```ts
if (inFlight) {
  pendingDirty = true
  return inFlight
}
```

All followers receive the **same** `inFlight` promise. That promise resolves
when the do/while loop finishes. The semantics this implies — "my mutation is
durable when the promise resolves" — is not what the code delivers:

- A follower that arrives during iteration 1 may resolve with iteration 1's
  bytes, even though their mutation only made it into the LDK state during
  iteration 2 (the trailing one).
- If iteration 1 fails (and per #335 the trailing iteration is dropped), all
  followers see a rejection even though their state would have succeeded.
- The chain-sync tick at `chain-sync.ts:234` `await`s the scheduler and on
  success clears `cmNeedsPersist=false` — believing its mutation is durable.
  Under the current shape, that's not guaranteed.

## Findings

- kieran-typescript P1 (alt-framing) and security-sentinel P2-3.
- Implicit contract gap: callers naturally read `await schedule()` as "my
  state is now persisted", but the implementation only guarantees "some
  iteration succeeded."

## Proposed Solutions

### Option A — Per-call settle promises (queue model)

Each call returns its own promise. The loop dequeues a batch of waiters per
iteration and resolves/rejects exactly that batch.

```ts
let waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = []
function schedule(): Promise<void> {
  return new Promise((resolve, reject) => {
    waiters.push({ resolve, reject })
    pendingDirty = true
    if (inFlight) return
    inFlight = (async () => {
      while (pendingDirty) {
        pendingDirty = false
        const batch = waiters; waiters = []
        try {
          await persistChannelManager(cm, ctx)
          batch.forEach(w => w.resolve())
        } catch (err) {
          batch.forEach(w => w.reject(err))
          // Keep pendingDirty signal: next iteration will run if more waiters arrive
        }
      }
    })().finally(() => { inFlight = null })
  })
}
```

- Pros: `await schedule()` semantics match expectations; composes with #335 fix.
- Cons: ~15 more LOC; subtle semantics need testing.
- Effort: Medium.
- Risk: Low–medium.

### Option B — Document current semantics, leave shape

Add JSDoc loudly stating "promise resolves on *some* iteration's completion,
not specifically yours." Cheaper but less correct.

### Option C — Drop `await` semantics: scheduler returns void

Make `schedule()` fire-and-forget at the type level (`() => void`); callers
that need durability (chain-sync) use a different API.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/storage/persist-cm.ts`, `src/ldk/storage/persist-cm.test.ts`
- **Affects:** `chain-sync.ts:234` retry logic correctness

## Acceptance Criteria

- [ ] Decision documented: either fix semantics or document divergence
- [ ] Test: caller B's `await` resolves only after iteration that includes B's mutation completes
- [ ] Test: caller A's rejection does not poison caller B's eventual success

## Work Log

_(empty)_

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/157
- Related: #335 (rejection swallowing), #343 (test gaps)
