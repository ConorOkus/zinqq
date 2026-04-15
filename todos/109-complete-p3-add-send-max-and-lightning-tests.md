---
status: complete
priority: p3
issue_id: 109
tags: [code-review, testing, send-flow]
dependencies: []
---

# Add send-max and Lightning flow tests to Send.test.tsx

## Problem Statement

The Send component's test suite covers the on-chain happy path well but lacks tests for:

1. **Send Max flow** — tapping the balance button populates numpad, then `estimateMaxSendable` is called after address entry
2. **Lightning flow** — zero-amount invoices using numpad amount, fixed-amount invoices skipping numpad amount, payment polling, and cancellation
3. **Error "Done" vs "Try Again"** — verifying `canRetry=false` navigates home

## Proposed Solutions

### Option A: Add targeted tests for each gap

- Add 4-5 new test cases covering send-max, Lightning fixed-amount, Lightning zero-amount, error Done, and error Try Again
- **Pros**: Focused, minimal effort
- **Cons**: Lightning tests require more complex mocking of `classifyPaymentInput`
- **Effort**: Small

## Acceptance Criteria

- [ ] Test: tapping balance fills numpad with unified balance
- [ ] Test: Lightning fixed-amount invoice uses parsed amount
- [ ] Test: Lightning zero-amount invoice uses numpad amount
- [ ] Test: Error "Done" navigates home
- [ ] Test: Error "Try Again" navigates to recipient
