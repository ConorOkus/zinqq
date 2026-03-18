---
status: pending
priority: p2
issue_id: 112
tags: [code-review, performance, storage]
---

# updatePaymentStatus scans all payments to update one

## Problem Statement

`updatePaymentStatus` in `src/ldk/storage/payment-history.ts:38` calls `loadAllPayments()` (full IDB cursor scan) to read a single record, then writes it back. Should use `idbGet` for O(1) key lookup.

## Acceptance Criteria

- [ ] `updatePaymentStatus` uses `idbGet` instead of `loadAllPayments()`
- [ ] Add deserialization helper to avoid duplicating BigInt conversion
