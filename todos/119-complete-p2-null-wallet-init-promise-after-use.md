---
status: pending
priority: p2
issue_id: 119
tags: [code-review, security, wallet]
dependencies: []
---

# Null out walletInitPromise after successful consumption

## Problem Statement

The module-level `walletInitPromise` in `src/wallet/context.tsx` caches the resolved wallet init result (including the mnemonic in the closure) for the lifetime of the page. After the `useEffect` `.then()` transfers the result to React state, the singleton is only needed for StrictMode dedup and serves no further purpose. Keeping it alive extends the mnemonic's in-memory lifetime unnecessarily.

## Findings

- **Security reviewer**: "If an attacker gains JavaScript execution context (via XSS, malicious browser extension, or memory dump), the mnemonic is recoverable from the heap. Set `walletInitPromise = null` after successful consumption to allow GC of the closure."

## Proposed Solutions

### Option A: Null out after consumption (Recommended)
Add `walletInitPromise = null` in the `.then()` callback after transferring state.

```typescript
initializeWallet()
  .then(({ ldkSeed, bdkDescriptors }) => {
    walletInitPromise = null  // Allow GC of the closure
    setState({ status: 'ready', ldkSeed, bdkDescriptors })
  })
```

- **Pros**: One-line fix, reduces mnemonic exposure window
- **Cons**: Does not fully solve the problem (JS strings cannot be zeroed), but meaningfully reduces exposure
- **Effort**: Small
- **Risk**: Low — StrictMode double-mount fires synchronously before the `.then()` callback, so dedup still works

## Technical Details

- **Affected files**: `src/wallet/context.tsx`

## Acceptance Criteria

- [ ] `walletInitPromise` set to `null` after successful state transfer
- [ ] StrictMode double-mount still works correctly (verified in dev)

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-16 | Created from PR #29 security review | Mnemonic in closure extends heap exposure |

## Resources

- PR: #29
- File: `src/wallet/context.tsx:35-38`
