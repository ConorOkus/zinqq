---
status: pending
priority: p3
issue_id: 116
tags: [code-review, cleanup]
---

# UnifiedTransaction.label always duplicates direction

## Problem Statement

The `label` field in `src/hooks/use-transaction-history.ts` is always "Sent" or "Received", directly derivable from `direction`. Remove it and derive display text in the component.

## Acceptance Criteria

- [ ] `label` removed from `UnifiedTransaction` type
- [ ] Activity.tsx derives display text from `direction`
