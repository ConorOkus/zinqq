---
status: pending
priority: p3
issue_id: 115
tags: [code-review, cleanup]
---

# paymentHistoryRef is write-only — remove it

## Problem Statement

`paymentHistoryRef` in `src/ldk/context.tsx:42` is set in `refreshPaymentHistory` and during init, but never read. Data flows through `setState` into context value. The ref serves no purpose.

## Acceptance Criteria

- [ ] `paymentHistoryRef` removed from context.tsx
