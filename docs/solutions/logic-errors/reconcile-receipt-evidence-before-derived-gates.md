---
title: 'Positive evidence must be checked before derived gates (phantom timelock blocked wallet receipts)'
category: logic-errors
date: 2026-07-21
tags: [close-records, reconciliation, evidence-ordering, timelock, fund-tracking]
modules: [src/ldk/close-records/reconcile]
---

# Positive evidence must be checked before derived gates (phantom timelock blocked wallet receipts)

## Problem

Close-record reconciliation gated ALL completion paths behind a timelock check
(`claimableAtHeight <= tipHeight`) — including the wallet-receipt path. Safety-net records
for offline **coop** closes carry a captured `to_self_delay` (their close type is
`'unknown'`, so the coop exemption didn't apply), producing a **phantom derived timelock**
that blocked the receipt check for up to ~2 weeks even though the closing tx was already
deeply confirmed **in our own BDK wallet**. The bug neutralized a P1 fix in the same
commit and was caught only by an adversarial verification pass.

## Root Cause

Ordering: a derived/heuristic gate (timelock computed from captured facts, which can be
wrong for records whose close type is unknown) was evaluated before direct positive
evidence (funds visibly received, ≥6 confs). Derived values inherit every classification
error upstream of them; direct evidence doesn't.

## Solution

`src/ldk/close-records/reconcile.ts`: the receipt check now runs **before** the timelock
gate — a ≥6-conf transaction confirmed in our own wallet completes the record regardless
of any derived timelock. Only the receipt-less outcomes (nothing-to-receive, resolved-unverified)
respect the gate. The un-swept-outputs gate stays in front of everything (a partial
sweep's receipt must not complete a record early — that gate is direct evidence too, not
derived).

```ts
if (pendingSpendables.has(current.channelId)) continue // direct: outputs still coming
if (receiptTx) {
  complete('verified')
  continue
} // direct evidence wins
if (!claimGate) continue // derived gate applies only to inference paths
```

## Prevention

When a state machine mixes **measured facts** (wallet receipts, confirmed outputs) with
**derived values** (computed timelocks, classified close types), order checks so measured
facts short-circuit first. Test the interaction explicitly: the regression test here is a
record with a _wrong_ derived timelock plus a _right_ wallet receipt
(`reconcile.test.ts` "wallet receipt beats a phantom derived timelock").
