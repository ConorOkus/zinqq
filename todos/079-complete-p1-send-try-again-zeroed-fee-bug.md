---
status: complete
priority: p1
issue_id: "079"
tags: [code-review, fund-safety, send-flow]
dependencies: []
---

# Send "Try Again" resets fee to 0n — fund safety bug

## Problem Statement

When a broadcast fails and the user clicks "Try Again" on the error screen, the handler reconstructs a `reviewing` state with `fee: 0n` and `feeRate: 0n`. The review screen then displays a total of `amount + 0` and a fee rate of `0 sat/vB`. If the user confirms, `sendToAddress` is called with `feeRate: 0n`, which could produce an unconfirmable transaction or fail at the BDK layer.

This is a **fund safety issue**: the user sees misleading fee information and could broadcast a transaction with an inadequate fee that gets stuck in the mempool.

## Findings

- **File:** `src/pages/Send.tsx`, error screen "Try Again" onClick handler
- **Identified by:** kieran-typescript-reviewer (Critical-1), security-sentinel (MEDIUM-2), code-simplicity-reviewer (Finding-5), architecture-strategist (High-1)
- All four review agents independently flagged this as the top-priority issue

```tsx
onClick={() => setSendStep({ step: 'reviewing', address: address.trim(), amount: amountSats, fee: 0n, feeRate: 0n, isSendMax: false })}
```

## Acceptance Criteria

- [ ] "Try Again" navigates to `{ step: 'amount' }` (forces fee re-estimation) instead of constructing a stale reviewing state
- [ ] Verify existing Send tests pass after the fix
- [ ] Add a test: after broadcast failure → Try Again → user must go through fee estimation before reaching review screen
