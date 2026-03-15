---
status: pending
priority: p1
issue_id: "044"
tags: [code-review, typescript, react, bug]
dependencies: []
---

# OnchainProvider useEffect depends on entire `ldk` context — causes infinite re-render loop

## Problem Statement

`OnchainProvider` includes the entire `ldk` context object as a useEffect dependency (`[bdkDescriptors, generateAddress, ldk]`). Every time `LdkProvider` updates state (which happens during init and on every `setBdkWallet` call), a new `ldk` object reference is created, re-triggering the OnchainProvider effect. This tears down the BDK sync loop and reinitializes the wallet on every LDK state change — a cascading re-render loop.

## Findings

- **File:** `src/onchain/context.tsx:78`
- **Root cause:** `useLdk()` returns a new object on every LDK state change. Including it in the dependency array causes the effect to re-fire.
- **Impact:** BDK wallet repeatedly torn down and recreated. Sync loop never stabilizes. Possible memory leaks from rapid WASM reinit.
- **Agents:** kieran-typescript-reviewer (CRITICAL), architecture-strategist (Risk 1)

## Proposed Solutions

### Option A: Extract stable function reference (Recommended)
Extract `setBdkWallet` into a stable reference before the effect:
```typescript
const ldk = useLdk()
const setBdkWalletRef = useRef<((w: Wallet | null) => void) | null>(null)
if (ldk.status === 'ready') setBdkWalletRef.current = ldk.setBdkWallet

useEffect(() => {
  // ...use setBdkWalletRef.current
}, [bdkDescriptors, generateAddress])
```
- **Pros:** Minimal change, stable deps
- **Cons:** Ref indirection
- **Effort:** Small
- **Risk:** Low

### Option B: Move setBdkWallet coordination to WalletGate
Have WalletGate own the handshake between LDK and OnchainProvider via a callback prop.
- **Pros:** Eliminates OnchainProvider's dependency on LDK context entirely
- **Cons:** Larger refactor, changes component responsibilities
- **Effort:** Medium
- **Risk:** Low

## Acceptance Criteria
- [ ] OnchainProvider useEffect does not re-run on LDK state changes
- [ ] BDK sync loop initializes once and remains stable
- [ ] setBdkWallet is called when BDK wallet is ready and LDK is available
