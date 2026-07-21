---
status: pending
priority: p1
issue_id: '400'
tags: [code-review, close-records, reconcile, correctness, pr-172]
dependencies: []
---

# Offline coop closes can never complete — safety-net records get role `commitment`, which receipt evidence ignores

## Problem Statement

A safety-net record (channel closed while the tab was closed, `closeType: 'unknown'`) gets
its discovered funding-spend labeled `'commitment'`
(`src/ldk/close-records/reconcile.ts:168`: `closeType === 'coop' ? 'closing' : 'commitment'`).
But the receipt check (line 204) only accepts roles `'sweep' | 'closing'`, and the
unverified fallback requires `closeType === 'coop'` or a `claimableAtHeight` that is never
set (see todo 397). Result: a coop close that happened while offline sits in "Closing"
status forever, even though the closing tx paid this wallet and is deeply confirmed.

## Findings

- kieran-typescript-reviewer Important #1.
- `txConfirmedInWallet` already demands the tx actually paid this wallet, so adding
  `'commitment'` to the receipt-candidate roles carries no false-positive risk: a real
  commitment tx never pays the BDK wallet directly (force-close funds arrive via sweep).

## Proposed Solutions

### Option A: Include `'commitment'` in the receipt-candidate roles

One-line change to `reconcile.ts:204` plus a test: safety-net record + wallet-confirmed
close tx → complete verified. Effort: Trivial. Risk: none (wallet-receipt check is the
real gate).

### Option B: Label unknown-close-type discoveries `'closing'`

Changes the display label too; commitment txs of force closes would be mislabeled.
Effort: Trivial. Risk: mislabeling.

## Recommended Action

(Triage — Option A.)

## Technical Details

- **Affected files**: `src/ldk/close-records/reconcile.ts`, `reconcile.test.ts`.

## Acceptance Criteria

- [ ] Offline coop close (safety-net record) completes verified once the closing tx is
      wallet-confirmed ≥6 confs
- [ ] Force-close commitment txs (not paying the wallet) still never count as receipts

## Work Log

- 2026-07-21: Filed from /ce:review of PR #172 (kieran-typescript-reviewer).
