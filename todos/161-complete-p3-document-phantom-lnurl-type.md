---
status: complete
priority: p3
issue_id: '161'
tags: [code-review, architecture]
dependencies: []
---

# Document that 'lnurl' type in ParsedPaymentInput is never returned by parser

## Problem Statement

The `lnurl` variant is constructed inline in Send.tsx, never by `classifyPaymentInput()`. Future developers may be confused by this phantom type. Add a JSDoc comment.

**File:** `src/ldk/payment-input.ts` line 19

## Acceptance Criteria

- [ ] JSDoc comment on the lnurl variant explains it's constructed by the send flow, not by classifyPaymentInput
