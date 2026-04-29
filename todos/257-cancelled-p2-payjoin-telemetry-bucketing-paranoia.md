---
status: cancelled
priority: p2
issue_id: '257'
tags: [code-review, payjoin, simplicity, yagni]
dependencies: []
---

# Telemetry bucketing comment claims privacy benefit that doesn't exist

## Problem Statement

`payjoin.ts:28-32` claims the 7-reason → 2-bucket aggregation in `emitOutcome` "denies a hostile receiver the ability to fingerprint our error path." This is incorrect.

`captureError` writes only to local IndexedDB (`src/storage/error-log.ts:47` — `idbPut('ldk_error_log', ...)`). There is **no remote telemetry transport** anywhere in Zinqq (`grep -rn "fetch.*analytics\\|posthog\\|sentry\\|amplitude\\|datadog" src/` returns nothing). The receiver cannot read the user's IndexedDB. There is no fingerprinting surface to defend against.

## Findings

- **code-simplicity-reviewer #1**: 7-variant union, `VALIDATION_REASONS` Set with one element, `emitOutcome` bucketing function, 5-line wrapper try/catch, 30+ lines of justification comments — all to translate 7 reasons into 2 bucket names that nothing reads remotely.

## Proposed Solutions

### Option 1 (recommended) — Inline direct `captureError` calls

Delete `VALIDATION_REASONS`, `emitOutcome`, the wrapper try/catch (lines 279-285 in `payjoin.ts`), and the explanatory comment block. Replace with direct calls at the throw sites:

```ts
captureError('warning', 'Payjoin', 'fallback', `${reason}: ${message}`)
```

Or even simpler, two telemetry events at outcome time:

```ts
// On success:
captureError('warning', 'Payjoin', 'success', undefined)
// On any failure inside the try/catch:
captureError('warning', 'Payjoin', 'failure', `${err.reason}: ${err.message}`)
```

- Pros: ~25 LOC saved; comment block honest; the reason-bucketing fiction is gone.
- Cons: loses the granular reason in the bucket name (now in the detail string). For local debugging this is fine.

### Option 2 — Keep the structure, fix the comment

Rewrite the comment to honestly say "two buckets aggregate similar failure modes for cleaner local debug logs" — drop the privacy claim.

- Pros: minimal code churn.
- Cons: still ships YAGNI infrastructure for non-existent remote telemetry.

## Recommended Action

Option 1. Bundles cleanly with the simplification of `tryPayjoinSend`'s try/catch structure (`code-simplicity-reviewer #9`).

## Technical Details

- Affected file: `src/onchain/payjoin/payjoin.ts` lines 28-32, 43, 90-98, 279-285
- Tests: existing tests assert on `PayjoinFallback.reason` (the throw-time field, unaffected) and on `captureError` mock calls (will update to expect inlined detail strings).

## Acceptance Criteria

- [ ] `VALIDATION_REASONS`, `emitOutcome`, justification comment removed
- [ ] Direct `captureError` at failure sites
- [ ] `payjoin.test.ts` updated to match new telemetry call shape
- [ ] No regression in `PayjoinFallback.reason` discriminant (kept for in-process control flow)

## Work Log

## Resources

- PR #143
- `src/storage/error-log.ts` — proves no remote transport

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
