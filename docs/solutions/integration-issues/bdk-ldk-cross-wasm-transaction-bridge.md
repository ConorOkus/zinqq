---
title: "BDK-LDK Cross-WASM Transaction Bridge via @scure/btc-signer"
category: integration-issues
date: 2026-03-13
module: src/onchain/tx-bridge, src/ldk/traits/event-handler
tags: [bdk, ldk, wasm, psbt, transaction-serialization, scure, channel-funding, esplora]
upstream_issue: https://github.com/bitcoindevkit/bdk-wasm/issues/38
status: temporary-workaround
---

# BDK-LDK Cross-WASM Transaction Bridge

## Problem

BDK-WASM's `Transaction` type does not expose `to_bytes()` or `from_bytes()` ([bdk-wasm#38](https://github.com/bitcoindevkit/bdk-wasm/issues/38)). This blocks passing finalized transactions between BDK and LDK WASM modules — specifically `channelManager.funding_transaction_generated()` which requires raw `Uint8Array` bytes. BDK's `EsploraClient.broadcast()` also takes the same unusable `Transaction` type.

## Root Cause

BDK-WASM wraps Rust's `bitcoin::Transaction` but does not expose the `consensus::serialize`/`consensus::deserialize` methods via `wasm_bindgen`. The only serializable output from BDK after signing is `Psbt.toString()` (base64 PSBT string).

## Solution

Use `@scure/btc-signer` (same ecosystem as existing `@scure/bip32` and `@scure/bip39`) to parse the PSBT base64 and extract the finalized raw transaction bytes.

### Bridge module (`src/onchain/tx-bridge.ts`)

```typescript
import { Transaction } from '@scure/btc-signer'

export function extractTxBytes(psbtBase64: string): Uint8Array {
  const psbtBytes = base64ToBytes(psbtBase64)
  const tx = Transaction.fromPSBT(psbtBytes)
  tx.finalize()
  return tx.extract()
}
```

### Two-phase funding flow in event handler

1. **FundingGenerationReady**: Build PSBT with BDK → sign → `extractTxBytes(psbt.toString())` → `channelManager.funding_transaction_generated(tempChannelId, counterpartyNodeId, rawTxBytes)` → cache tx hex by temp channel ID
2. **FundingTxBroadcastSafe**: Look up cached tx by `former_temporary_channel_id` → POST to Esplora `/tx` → delete cache on success

### Key patterns discovered

- **Cache delete must happen in success callback**, not before broadcast. Network failure must not lose the signed transaction.
- **Funding tx cache must be scoped to the handler closure**, not module-level. Module-level `Map` leaks state across handler instances and test runs.
- **`FundingTxBroadcastSafe` provides `former_temporary_channel_id`** — so the same key used at cache-write time works at read time. No mapping needed.
- **`DiscardFunding` provides final `channel_id` (not temporary)** — cannot directly clean up cache. Accept small leak; cleared on tab refresh.
- **`Psbt.toString()` returns base64 with partial signatures** (not finalized). `@scure/btc-signer` handles finalization via `tx.finalize()` before `tx.extract()`.

## Prevention / Best Practices

- When two WASM modules need to exchange data, check if the bridge type exposes serialization. If not, find the nearest serializable format (PSBT base64 in this case) and use a JS library to convert.
- Mark all workaround code `// TEMPORARY` with the upstream issue link so it can be found and removed.
- Isolate workaround code in a single file for easy deletion.
- For fund-safety critical paths: never delete cached data before the operation that consumes it succeeds.

## Related

- [bdk-wasm-onchain-wallet-integration-patterns.md](./bdk-wasm-onchain-wallet-integration-patterns.md) — Section 4 documents this issue as "unresolved"
- [ldk-event-handler-patterns.md](./ldk-event-handler-patterns.md) — Sync/async bridging patterns used in the event handler
- Upstream: [bitcoindevkit/bdk-wasm#38](https://github.com/bitcoindevkit/bdk-wasm/issues/38)
- PR: [#8](https://github.com/ConorOkus/browser-wallet/pull/8)
