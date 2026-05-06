---
status: pending
priority: p2
issue_id: '314'
tags: [code-review, architecture, simplicity, pr-150]
dependencies: []
---

# Eliminate `requestCounterRef` — redundant with `AbortController`

## Problem Statement

`Receive.tsx` uses BOTH a monotonic counter (`requestCounterRef`) and an `AbortController` to scope concurrent quote requests. The plan explicitly said the AbortController should *replace* the counter — but the implementation kept both. With `ctrl.abort()` firing in the cleanup and `getJitQuote` rejecting with `AbortError` on the aborted signal, the `requestCounterRef.current !== thisRequest` guards in `.then`/`.catch` are largely defensive duplication.

## Findings

- **File**: `src/pages/Receive.tsx:77` (counter declared), `:165, :188, :199, :219, :242, :455` (counter compared/incremented)
- **File**: `src/pages/Receive.tsx:180-220` (AbortController plumbing)
- **Identified by**: architecture-strategist (#3), kieran-typescript-reviewer (#3), code-simplicity-reviewer (#8)
- The plan said: "AbortController replaces `requestCounterRef`" — drift from plan to implementation

## Proposed Solutions

### Option A: Delete `requestCounterRef`, rely solely on AbortController (Recommended)

- The `then`/`catch` callbacks check `signal.aborted` instead of comparing counter values
- Cleanup function only calls `ctrl.abort()`
- **Pros**: Plan satisfied; one cancellation primitive instead of two; ~6 LOC removed
- **Cons**: Need to verify `AbortError` is the only "stale" signal we care about
- **Effort**: Small
- **Risk**: Low — but worth a careful re-test of the race scenarios

### Option B: Unify both into a `JitRequestToken` abstraction

- Single object that combines a sequence number AND an AbortController
- **Pros**: Less churn at call sites
- **Cons**: New abstraction; doesn't solve the underlying redundancy
- **Effort**: Small

### Option C: Document why both are kept

- Comment explaining the layered protection
- **Pros**: Tiniest change
- **Cons**: Doesn't fix the smell; future maintainers still confused
- **Effort**: Tiny

## Recommended Action

(Filled during triage — leaning Option A)

## Technical Details

- **Affected files**: `src/pages/Receive.tsx`
- **Test impact**: Race-condition tests in `Receive.test.tsx` may need to assert on AbortError specifically

## Acceptance Criteria

- [ ] `requestCounterRef` removed (Option A) OR documented (Option C)
- [ ] All concurrency-control tests still pass
- [ ] `pnpm test` and `pnpm lint` pass

## Work Log

(Empty)

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/150
- Solutions doc: `docs/solutions/integration-issues/lsps2-jit-receive-react-effect-dependencies.md`
