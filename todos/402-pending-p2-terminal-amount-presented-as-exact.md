---
status: pending
priority: p2
issue_id: '402'
tags: [code-review, close-records, ui, honesty, pr-172]
dependencies: []
---

# Terminal close amount drops the `~` but is never measured — pre-fee estimate presented as exact

## Problem Statement

`ChannelCloseDetail.tsx:160` removes the `~` prefix when a record is terminal, and the
`CloseRecord.expectedAmountSats` comment claims "measured from wallet receipt at
completion" — but nothing implements measurement (reconcile's completion upserts carry no
amount). Meanwhile absorption hides the real on-chain receive from history. The user sees
LDK's `last_local_balance` (pre-close-fee) presented as exact, permanently.

## Findings

- kieran-typescript-reviewer Important #3.
- The persisted `SpendableOutputsEntry.outpoints[].valueSats` (currently unconsumed — see
  todo 407 wire-or-drop) would serve measurement, as would the receipt tx's
  wallet-received value via `bdkWallet.sent_and_received`.
- This was a declared PR deviation ("measured amounts deferred") — but the UI dropping the
  `~` and the type comment were not aligned with the deferral.

## Proposed Solutions

### Option A: Keep the `~` on terminal records + fix the comment (honest deferral)

Effort: Trivial. Risk: none.

### Option B: Measure at completion

In reconcile's verified branch, set a `receivedAmountSats` fact from the receipt tx's
wallet-received value (or summed descriptor `valueSats`); UI prefers it and drops `~` only
when present. Effort: Medium. Risk: low.

## Recommended Action

(Triage — A now, B as the follow-up that also resolves the valueSats wire-or-drop.)

## Technical Details

- **Affected files**: `src/pages/ChannelCloseDetail.tsx`, `src/ldk/close-records/close-record.ts`
  (comment or new fact), `reconcile.ts` (Option B).

## Acceptance Criteria

- [ ] No unmeasured amount is ever displayed without the estimate marker
- [ ] Type comments describe what the code actually does

## Work Log

- 2026-07-21: Filed from /ce:review of PR #172 (kieran-typescript-reviewer).
