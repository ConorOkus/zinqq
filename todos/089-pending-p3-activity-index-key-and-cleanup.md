---
status: pending
priority: p3
issue_id: "089"
tags: [code-review, quality]
dependencies: []
---

# Activity: add unique IDs to transactions, remove trivial variables

## Problem Statement

Activity.tsx uses array index as React `key` (will cause issues with real data) and has unnecessary `transactions` alias and `isEmpty` variable.

## Findings

- **File:** `src/pages/Activity.tsx`
- **Identified by:** kieran-typescript-reviewer (Medium-7), code-simplicity-reviewer (Finding-4)

## Acceptance Criteria

- [ ] Add `id` field to mock transaction objects and use as key
- [ ] Inline `MOCK_TRANSACTIONS` usage and remove `isEmpty` variable
