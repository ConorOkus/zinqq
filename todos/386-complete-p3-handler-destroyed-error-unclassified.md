---
status: complete
priority: p3
issue_id: '386'
tags: [code-review, lsps2, telemetry, pr-167]
dependencies: []
---

# `Lsps2HandlerDestroyedError` not classified in `classifyJitTrigger`

## Problem Statement

The typed error taxonomy (todo 379) wired `Lsps2TimeoutError`,
`Lsps2PeerDisconnectedError`, and `Lsps2BackpressureError` into
`classifyJitTrigger` (`src/ldk/context.tsx`), but omitted the fourth transport
type, `Lsps2HandlerDestroyedError` (thrown on handler teardown /
`message-handler.ts` `destroy`). It currently classifies as generic `'lsps2_rpc'`,
partially undercutting the stated goal of separating transport failures from real
RPC failures in incident logs. Flagged by the TypeScript reviewer (P3-b).

## Findings

- `Lsps2HandlerDestroyedError` fires when a request is pending during node
  shutdown/teardown — a benign state worth distinguishing from a real RPC failure.

## Proposed Solutions

### Option A: Add the classifier arm

Import `Lsps2HandlerDestroyedError` and add
`if (err instanceof Lsps2HandlerDestroyedError) return 'lsps2_handler_destroyed'`
(extend the `JitTrigger` union). Effort: Trivial.

### Option B: Document the intentional fall-through

If lumping shutdown teardown into `'lsps2_rpc'` is acceptable, add a one-line
comment saying so, so a future reader doesn't think it was an oversight. Effort:
Trivial.

## Recommended Action

(Triage) Option A — completes the taxonomy and gives telemetry a benign-shutdown
signal.

## Technical Details

- **Affected files**: `src/ldk/context.tsx` (`JitTrigger` union + `classifyJitTrigger`).

## Acceptance Criteria

- [ ] `Lsps2HandlerDestroyedError` is either classified distinctly or documented as
      an intentional fall-through.

## Work Log

- 2026-07-07: Filed from `/ce:review` (delta review) of PR #167.
- 2026-07-07: Fixed (Option A). Added `Lsps2HandlerDestroyedError` →
  `'lsps2_handler_destroyed'` arm + union member in `classifyJitTrigger`
  (`context.tsx`). Typecheck + tests pass.
