---
status: pending
priority: p2
issue_id: "045"
tags: [code-review, security, cryptography]
dependencies: []
---

# Plaintext mnemonic in IndexedDB and xprv descriptors in React state

## Problem Statement

The BIP39 mnemonic is stored as a plaintext string in IndexedDB (`wallet_mnemonic` store). Extended private keys (xprv) flow through React state and props via `WalletContextValue.bdkDescriptors`. Both are extractable by browser extensions, React DevTools, or heap snapshots.

Acceptable for Signet stage per plan: "encryption deferred to mainnet phase." Tracked here for mainnet readiness.

## Findings

- **Mnemonic:** `src/wallet/mnemonic.ts:24` — raw string in IDB via `idbPut`
- **xprv in state:** `src/wallet/wallet-context.ts:9-11` — `bdkDescriptors` contains full xprv strings
- **xprv in props:** `src/wallet/wallet-gate.tsx:78` → `src/onchain/context.tsx:14`
- **Agent:** security-sentinel (CRITICAL-1, CRITICAL-2)

## Proposed Solutions

### Option A: Encrypt mnemonic with user passphrase
Use `SubtleCrypto.deriveKey()` with PBKDF2 + AES-GCM to wrap the mnemonic. Adds a login/unlock flow.
- **Effort:** Medium | **Risk:** Low

### Option B: Derive keys at init boundary, not in React state
Move descriptor derivation into `initializeBdkWallet()` directly. Pass only an opaque wallet handle through context, not xprv strings.
- **Effort:** Medium | **Risk:** Low

## Acceptance Criteria
- [ ] Mnemonic encrypted at rest in IDB (before mainnet)
- [ ] xprv strings not present in React state/props
- [ ] Key derivation happens at WASM init boundary
