---
status: complete
priority: p2
issue_id: '379'
tags: [code-review, lsps2, telemetry, error-handling, pr-167]
dependencies: []
---

# LSPS2 typed error taxonomy is thrown but never consumed (telemetry + docstring overclaim)

## Problem Statement

PR #167 added `src/ldk/lsps2/errors.ts` (`Lsps2TransportError` → `Lsps2TimeoutError` /
`Lsps2PeerDisconnectedError` / `Lsps2HandlerDestroyedError` / `Lsps2BackpressureError`).
Its docstring — and the plan's success metric ("Incident logs can distinguish timeout
vs disconnect vs backpressure") — claim the taxonomy exists for telemetry and the
failover decision. Structurally it does neither: `classifyJitTrigger`
(`src/ldk/context.tsx:110-116`) has no branch for any `Lsps2*` type, so every transport
error falls through to the single `'lsps2_rpc'` bucket, and `context.tsx` does not import
`./lsps2/errors` at all. The abstraction is currently write-only from the classifier's
perspective — the incident-log discrimination the PR advertises isn't actually achieved.

Raised independently by the TypeScript reviewer (P2), architecture-strategist (Medium #1),
and the code-simplicity reviewer.

## Findings

- `classifyJitTrigger` (`context.tsx:110-116`) buckets all transport errors as
  `'lsps2_rpc'`; timeout/disconnect/backpressure are indistinguishable in telemetry.
- The primary→fallback warning log (`context.tsx:514-524`) records only
  `trigger: classifyJitTrigger(err)`, not `String(err)`, so even the error name is lost
  at that site.
- `errors.ts:9-11` additionally mischaracterizes the buy path: "On the buy path they
  surface to the user without triggering failover." The buy path DOES re-quote the
  fallback at the app layer (`src/pages/Receive.tsx:461` → `reQuoteSkippingPrimary`).
  Accurate wording: "the same buy is never retried against another LSP; the app still
  re-quotes the fallback as a fresh flow."
- Behavior is still correct — failover eligibility keys on `signal.aborted`, not error
  type, so transport errors remain failover-eligible on the quote path (covered by the
  new test at `jit-failover.test.ts`). This is a design-intent / observability gap, not
  a correctness bug.

## Proposed Solutions

### Option A: Wire the taxonomy into telemetry (fulfill the stated intent)

Extend the `JitTrigger` union and add branches to `classifyJitTrigger`, e.g.
`if (err instanceof Lsps2TimeoutError) return 'lsps2_timeout'` (+ disconnect/backpressure),
and add `error: String(err)` to the `captureError` payload at `context.tsx:514-524`.
Pros: delivers the advertised incident-log discrimination. Cons: touches the trigger
union + any downstream consumers of it. Effort: Small.

### Option B: Soften the docstring to match reality

Downgrade `errors.ts` docs to "typed for throw-site clarity + `String(err)` telemetry"
and fix the buy-path wording. Pros: zero behavior change. Cons: leaves the plan's success
metric unmet. Effort: Small.

## Recommended Action

(Triage) Option A — it's small and the telemetry value is the reason the taxonomy was
added. Fold in the buy-path docstring correction either way.

## Technical Details

- **Affected files**: `src/ldk/context.tsx` (`classifyJitTrigger`, failover warning),
  `src/ldk/lsps2/errors.ts` (docstring).

## Acceptance Criteria

- [ ] Timeout vs disconnect vs backpressure are distinguishable in the incident log
      (distinct trigger and/or `String(err)` in the payload).
- [ ] `errors.ts` docstring accurately describes buy-path behavior (app re-quotes
      fallback; same buy not retried against another LSP).
- [ ] Existing failover tests still pass.

## Work Log

- 2026-07-07: Filed from `/ce:review` of PR #167.
- 2026-07-07: Fixed (Option A). Extended `JitTrigger` with `lsps2_timeout` /
  `lsps2_peer_disconnected` / `lsps2_backpressure`; `classifyJitTrigger` now
  branches on the `Lsps2*` types (`context.tsx`). Added `error: String(err)` to
  the primary→fallback warning payload. Corrected the buy-path wording in
  `errors.ts`. Added a failover test asserting the `lsps2_timeout` trigger is
  emitted. Full suite green (474), lint clean.
