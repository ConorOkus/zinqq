---
status: pending
priority: p3
issue_id: '393'
tags: [code-review, receive, state-machine, simplification, pr-168]
dependencies: ['388', '392']
---

# Fold `invoiceExpiresAt` into the `ready`/`jit` state variant

## Problem Statement

The parallel `useState<number | null>` for `invoiceExpiresAt` must be manually zeroed at
four sites, and the timer effect needs a functional-update guard (plus explanatory comment)
precisely because the timestamp can outlive the screen it belongs to. Putting the expiry on
the state it describes makes the value die automatically with every state transition.
code-simplicity-reviewer rated this P2-as-cleanup but explicitly "recommended cleanup, not a
defect" — the current shape is consistent with the file's existing parallel-state pattern
(`invoice`, `paymentHash`, `openingFeeSats`). Filed as P3.

## Findings

- Reset sites: `src/pages/Receive.tsx:169, :183, :234` (+ set at `:468`).
- Timer effect + guard + comment: `src/pages/Receive.tsx:271-282`.
- Latent leftover: `handleReviewBack` (`:495-503`) leaves `invoiceExpiresAt` set; only the
  main effect's re-run incidentally clears it — the guard papers over that (the guard's
  `invoicePath === 'jit'` check does make a late fire harmless).

## Proposed Solutions

### Option A (recommended): Widen the state variant

`{ step: 'ready'; invoicePath: 'jit'; expiresAtMs: number }` (or optional field on `ready`),
derive `jitExpiresAt` from `receiveState`, key the effect on the derivation. Removes all
four resets, the guard, and its comment (~10 LOC net, one less invariant). Effort: Small.
Risk: low — touches the `ready` construction sites.

### Option B: Leave as-is

Consistent with the file's parallel-state pattern; the guard is correct today. Effort: none.

## Recommended Action

(Triage) If 392's variant merge happens, do this in the same pass — both reshape
`ReceiveState`.

## Technical Details

- **Affected files**: `src/pages/Receive.tsx`, `src/pages/Receive.test.tsx`.

## Acceptance Criteria

- [ ] No standalone `invoiceExpiresAt` state; expiry lives on (or derives from) the state union.
- [ ] Timer guard and manual resets removed.
- [ ] Expired-flow test passes unchanged in behavior.

## Work Log

- 2026-07-08: Filed from `/ce:review` of PR #168 (code-simplicity-reviewer).
