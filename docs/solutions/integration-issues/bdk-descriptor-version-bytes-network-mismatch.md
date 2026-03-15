---
title: "BDK Descriptor Version Bytes: tprv vs xprv Network Mismatch"
category: integration-issues
date: 2026-03-14
module:
  - src/wallet/keys
  - src/onchain
tags:
  - bdk
  - wasm
  - bip32
  - descriptors
  - signet
  - network
  - key-derivation
  - scure
severity: high
symptom: "Key error: Invalid network"
---

# BDK Descriptor Version Bytes: tprv vs xprv Network Mismatch

## Problem

When initializing a BDK WASM wallet for the signet network, wallet creation fails with:

```
Key error: Invalid network
```

The wallet is completely non-functional — no address generation, no balance sync, no channel funding.

## Root Cause

`@scure/bip32`'s `HDKey.fromMasterSeed(seed)` defaults to **mainnet** BIP32 version bytes (`0x0488ADE4`), producing extended keys with the `xprv` prefix. BDK WASM validates that descriptor extended key version bytes match the target network parameter. Signet expects **testnet** version bytes (`0x04358394`), which produce the `tprv` prefix. Passing an `xprv`-prefixed descriptor to `Wallet.create('signet', ...)` triggers the validation failure.

The BIP32 version bytes control how `privateExtendedKey` is serialized:

| Network | Private Version | Prefix | Public Version | Prefix |
|---------|----------------|--------|----------------|--------|
| Mainnet | `0x0488ADE4` | `xprv` | `0x0488B21E` | `xpub` |
| Testnet/Signet | `0x04358394` | `tprv` | `0x043587CF` | `tpub` |

## Solution

Pass testnet version bytes to `HDKey.fromMasterSeed()` when the target network is not mainnet.

**Before:**

```typescript
const seed = mnemonicToSeedSync(mnemonic)
const master = HDKey.fromMasterSeed(seed)  // Always uses mainnet xprv
```

**After:**

```typescript
const TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587cf }

const seed = mnemonicToSeedSync(mnemonic)
const versions = network === 'bitcoin' ? undefined : TESTNET_VERSIONS
const master = HDKey.fromMasterSeed(seed, versions)  // tprv for signet, xprv for mainnet
```

The `versions` parameter is the second argument to `fromMasterSeed()` — when `undefined`, it defaults to mainnet. The derived `account.privateExtendedKey` then serializes with the correct prefix, and BDK accepts the descriptor.

**Test assertion** to lock this down:

```typescript
it('uses tprv for signet and xprv for mainnet', () => {
  const signet = deriveBdkDescriptors(TEST_MNEMONIC, 'signet')
  expect(signet.external).toMatch(/\]tprv/)

  const mainnet = deriveBdkDescriptors(TEST_MNEMONIC, 'bitcoin')
  expect(mainnet.external).toMatch(/\]xprv/)
})
```

**Post-fix:** Users must clear the IndexedDB `bdk_changeset` store, since the persisted changeset was created with invalid descriptors. BDK will then create a fresh wallet with correct `tprv` descriptors and run a full scan.

## Prevention

1. **Test both networks:** Always assert the extended key prefix for each supported network in unit tests. The regex `/\]tprv/` and `/\]xprv/` catch mismatches at test time.

2. **Match version bytes to BDK network:** When using `@scure/bip32` to construct BDK descriptors, the `fromMasterSeed` version bytes must match the network passed to `Wallet.create()`. This is not optional — BDK enforces it.

3. **Reuse `TESTNET_VERSIONS` for all non-mainnet networks:** Testnet, signet, and regtest all use the same BIP32 version bytes. A single constant covers all cases.

4. **Consider a runtime prefix assertion:** Before passing descriptors to BDK, validate the key prefix matches expectations (e.g., signet descriptor must contain `tprv`). This turns BDK's opaque "Key error: Invalid network" into a clear, actionable error message.

## Related Documentation

- [BDK WASM Onchain Wallet Integration Patterns](bdk-wasm-onchain-wallet-integration-patterns.md) — Section 6 covers BIP84 descriptor construction and previously noted that @scure/bip32 always uses mainnet version bytes. This solution corrects that approach.
- [BDK-LDK Cross-WASM Transaction Bridge](bdk-ldk-cross-wasm-transaction-bridge.md) — Context on @scure ecosystem coordination between BDK and LDK WASM modules.
