---
status: pending
priority: p1
issue_id: "061"
tags: [code-review, security]
dependencies: []
---

# No double-submit guard on Confirm Send button

## Problem Statement

The `handleConfirm` function in Send.tsx sets state to `broadcasting` but there is no ref-based lock preventing double invocation. If a user double-clicks "Confirm Send" before the first React render cycle completes (changing the step to `broadcasting`), `sendToAddress` or `sendMax` could be invoked twice. BDK's UTXO selection would likely fail the second call, but there is a window where both calls could select the same UTXOs.

## Findings

**Location:** `src/pages/Send.tsx`, lines 141-156

The button calls `() => void handleConfirm()` without a ref-based guard. The button is only disabled when `sendStep.step === 'broadcasting'`, but state updates are asynchronous.

Flagged by: security-sentinel

## Proposed Solutions

### Option A: useRef guard (Recommended)
Add a `sendingRef = useRef(false)` that is checked and set synchronously at the top of `handleConfirm`, preventing any double invocation.

```typescript
const sendingRef = useRef(false)
const handleConfirm = useCallback(async () => {
  if (sendingRef.current || onchain.status !== 'ready' || sendStep.step !== 'reviewing') return
  sendingRef.current = true
  setSendStep({ step: 'broadcasting' })
  try { ... } finally { sendingRef.current = false }
}, [...])
```

- Pros: Synchronous guard, no race window
- Cons: One additional ref
- Effort: Small
- Risk: Low

## Acceptance Criteria

- [ ] A ref-based guard prevents double invocation of handleConfirm
- [ ] Confirm button is also disabled during broadcasting step
- [ ] Test verifies second click during broadcast does not call sendToAddress again
