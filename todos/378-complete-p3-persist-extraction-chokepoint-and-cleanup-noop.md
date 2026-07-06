---
status: complete
priority: p3
issue_id: 378
tags: [code-review, ldk, hygiene, simplification]
dependencies: []
---

# Code hygiene: single sync-extraction choke point in persist; retire the event-handler cleanup no-op

## Problem Statement

Two low-impact hygiene items from the 0.2 migration review:

1. **Split WASM extraction.** `keyForMonitor()` and `handlePersist()` both touch
   `monitor.get_funding_txo()` within the same synchronous persist callback. Both calls are
   synchronous (safe), but the "only touch the borrowed WASM object synchronously" invariant is
   now spread across two functions with no single choke point, making the freed-object hazard
   easier to reintroduce. (See also #375.)

2. **`cleanup: () => {}` no-op.** With the forward timer removed, `createEventHandler` returns an
   empty `cleanup` kept "for caller API stability." Callers still invoke it (`init.ts`,
   `context.tsx` teardown). An empty lifecycle hook is a mild abstraction leak — a reader can't
   tell if it's intentionally empty or forgotten. Fully removing it means dropping `cleanup` from
   the return type, the `InitResult` field, and the teardown call site (~4 files) — a separate
   small PR, not inline churn here.

## Findings

- `src/ldk/traits/persist.ts:254-261` (`handlePersist`) + `:286-290` (`keyForMonitor`) — both call `monitor.get_funding_txo()`.
- `src/ldk/traits/event-handler.ts:~159-163` — `cleanup: () => {}` no-op (comment present, good).

## Proposed Solutions

- Consolidate all synchronous extraction (`key`, `channelId` bytes, `data`, `updateId`) into one helper called once at the top of the persist callbacks, passing owned values onward. Pairs naturally with the #375 fix.
- Either remove `cleanup` end-to-end (separate PR) or keep it with its explanatory comment (current state is acceptable).
- Effort: Small. Risk: Low.

## Recommended Action

_(leave blank for triage)_

## Acceptance Criteria

- [ ] Persist callbacks extract everything from the borrowed monitor in one synchronous place.
- [ ] Decision recorded on `cleanup`: removed (with call sites updated) or kept intentionally.

## Work Log

- 2026-07-06 — Filed from `/ce:review` of PR #166 (architecture + simplicity).

## Resources

- PR #166. Related: #375 (use-after-free), #374.
- 2026-07-06 — DONE (extraction). Consolidated all borrowed-monitor reads into a single `extractMonitor()` choke point; `handlePersist` now takes owned values and never touches the monitor. Decision on `cleanup`: KEEP the documented no-op (removing it touches 4 files across the return-type contract — deferred, not worth inline churn); its explanatory comment stands.
