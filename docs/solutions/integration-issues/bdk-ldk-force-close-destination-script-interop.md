---
title: 'BDK/LDK force-close destination interop — deterministic address derivation'
category: integration-issues
date: 2026-03-26
tags:
  [
    bdk,
    ldk,
    force-close,
    address-derivation,
    signer-provider,
    vss-recovery,
    cross-device,
    init-order,
  ]
related_files:
  - src/onchain/address-utils.ts
  - src/ldk/traits/bdk-signer-provider.ts
  - src/ldk/init.ts
  - src/ldk/traits/event-handler.ts
  - src/onchain/context.tsx
  - src/onchain/init.ts
  - src/ldk/context.tsx
  - src/ldk/ldk-context.ts
pr: https://github.com/ConorOkus/zinqq/pull/55
---

# BDK/LDK Force-Close Destination Script Interop

## Problem

After a force close, the on-chain balance in the BDK wallet did not reflect the returned channel funds. Funds were sent to LDK's internal KeysManager addresses (`m/535'/0'`), which BDK had no knowledge of. On cross-device VSS recovery, a restored wallet derived different destination addresses than the original device, meaning recovered ChannelMonitors pointed to addresses the new device's BDK wallet would never discover.

Funds were safe (same seed controlled both derivation paths) but invisible to the user's on-chain balance.

## Root Cause

**1. BDK initialized after LDK — wallet was null during deserialization.**

LDK's `ChannelManager` and `ChannelMonitor` deserialization calls `SignerProvider.get_destination_script()` to reconstruct the scripts that force-close transactions pay to. BDK wallet initialization (including its Esplora full scan) happened after LDK init completed, so the `SignerProvider` had no BDK wallet reference during deserialization and fell back to KeysManager default addresses.

**2. `revealNextAddress` was non-deterministic across devices.**

The previous implementation used `wallet.next_unused_address()` for `get_destination_script`. This advances an internal counter, so the address returned depends on how many addresses have already been revealed. Two devices restoring from the same seed via VSS get different addresses for the same channel because their BDK address counters diverged.

## Solution

Three coordinated changes:

### 1. Eager BDK wallet init before LDK deserialization

Split `onchain/init.ts` into two phases:

- `initializeBdkWalletEager()` — creates/restores wallet from persisted ChangeSet without chain scan (fast, no network I/O)
- `fullScanBdkWallet()` — performs Esplora full scan later, after LDK is fully initialized

In `ldk/init.ts`, eager init runs before KeysManager and SignerProvider creation:

```typescript
const { wallet: bdkWallet, esploraClient: bdkEsploraClient } = await initializeBdkWalletEager(
  bdkDescriptors,
  ONCHAIN_CONFIG.network
)
```

### 2. Deterministic address derivation from channel_keys_id

`peekAddressAtIndex()` maps `channel_keys_id` to a deterministic BDK derivation index:

```typescript
function channelKeysIdToIndex(channelKeysId: Uint8Array): number {
  const view = new DataView(
    channelKeysId.buffer,
    channelKeysId.byteOffset,
    channelKeysId.byteLength
  )
  const raw = view.getUint32(0, false) // big-endian
  return raw % 10_000
}

export function peekAddressAtIndex(wallet: Wallet, channelKeysId: Uint8Array): Uint8Array {
  const index = channelKeysIdToIndex(channelKeysId)
  const addressInfo = wallet.peek_address('external', index)
  const scriptBytes = addressInfo.address.script_pubkey.as_bytes()
  wallet.reveal_addresses_to('external', index)
  // persist changeset...
  return scriptBytes
}
```

- `peek_address` does not advance the internal counter (deterministic)
- `reveal_addresses_to` marks the address as known to BDK for syncing
- 10,000 modulus bounds the index range; collisions are harmless (same wallet) but reduce privacy

### 3. Removed lazy `setBdkWallet` pattern

Both `createBdkSignerProvider` and `createEventHandler` now accept `bdkWallet: Wallet` as a required parameter. No nullable wallet references, no null guards, no fallback paths during normal operation. The `OnchainProvider` reads the pre-initialized wallet from LDK context using stable refs to avoid re-render churn.

## Pitfalls

1. **`peek_address` vs `next_unused_address` is load-bearing.** Using `next_unused_address` for `get_destination_script` re-introduces the non-determinism bug. Only `peek_address` with a deterministic index is correct for force-close scripts.

2. **`reveal_addresses_to` is required after `peek_address`.** Without it, BDK would not track the address during sync and incoming force-close funds would be invisible to the balance.

3. **Cooperative close vs force close use different strategies by design.** `get_shutdown_scriptpubkey` (cooperative) uses non-deterministic `next_unused_address` because the shutdown script is persisted in channel state at open time and replayed from serialization. `get_destination_script` (force close) must be deterministic because it is recomputed on every deserialization.

4. **Eager init must not perform network I/O.** `initializeBdkWalletEager` only restores from ChangeSet or creates fresh. The full Esplora scan runs later. Slowness here would delay the entire app startup.

5. **OnchainProvider must use stable refs for LDK-provided values.** The `ldk` context object changes reference on every state update (sync status, channel counter, etc.). Depending on it directly in a useEffect causes the full-scan + sync-loop to tear down and restart. Use refs populated by a separate effect.

6. **Birthday paradox on address collisions.** At 10,000 slots, collision probability reaches ~1% at 12 channels and ~50% at 118 channels. Collisions do not cause fund loss but link channels on-chain.

## Prevention

- **Ban lazy-set patterns for critical dependencies.** If a value is needed during deserialization, it must be present at construction time, not injected later via a setter.
- **Use deterministic derivation for all LDK-facing addresses.** Any address that LDK may send funds to must be derivable purely from data LDK already stores.
- **Code review checklist:** Does any change call `next_unused_address` in a context reachable from LDK? It should be `peek_address` with a deterministic index.
- **Test force-close fund visibility end-to-end.** After force close, assert BDK balance reflects the returned funds.
- **Test recovery determinism.** Restore from seed, derive destination script for a known `channel_keys_id`, assert it matches the original.

## Related Documentation

- [BDK/LDK SignerProvider fund routing](bdk-ldk-signer-provider-fund-routing.md) — original custom SignerProvider implementation
- [BDK address reveal not persisted](../logic-errors/bdk-address-reveal-not-persisted.md) — changeset persistence after `next_unused_address`
- [BDK-WASM onchain wallet integration patterns](bdk-wasm-onchain-wallet-integration-patterns.md) — React context patterns, init order, re-render avoidance
- [LDK event handler patterns](ldk-event-handler-patterns.md) — SpendableOutputs handling and sweep destinations
- [VSS remote state recovery](vss-remote-state-recovery-full-integration.md) — cross-device recovery flow
