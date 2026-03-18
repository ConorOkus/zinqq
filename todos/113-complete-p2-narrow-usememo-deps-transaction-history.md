---
status: pending
priority: p2
issue_id: 113
tags: [code-review, performance, react]
---

# useMemo in useTransactionHistory depends on entire context objects

## Problem Statement

`src/hooks/use-transaction-history.ts:68` has `[onchain, ldk]` as useMemo deps. Both context objects change reference on every state update (balance changes, sync status, channel counter). The memo recomputes the full transaction list on every unrelated context change.

## Acceptance Criteria

- [ ] useMemo depends on granular signals (e.g. `onchain.status`, `onchain.balance`, `ldk.paymentHistory`)
- [ ] Activity screen does not re-render on unrelated sync status changes
