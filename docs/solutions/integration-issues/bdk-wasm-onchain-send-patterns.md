---
title: BDK WASM Onchain Send — Build/Sign/Broadcast Pipeline Patterns
category: integration-issues
date: 2026-03-14
module: src/onchain
tags: [bdk, wasm, send, transaction, broadcast, fee-estimation, react-context]
severity: HIGH
related:
  - bdk-wasm-txbuilder-consumes-self.md
  - bdk-wasm-onchain-wallet-integration-patterns.md
  - bdk-ldk-cross-wasm-transaction-bridge.md
---

# BDK WASM Onchain Send — Build/Sign/Broadcast Pipeline

## Problem

Building a send flow for a BDK WASM wallet involves multiple interacting concerns: fee estimation, transaction building, signing, changeset persistence, broadcasting, and sync loop coordination. Several non-obvious pitfalls emerge from the WASM ownership model and async interleaving.

## Key Patterns

### 1. Extract a Shared Build-Sign-Broadcast Helper

The send-to-address and send-max flows share ~90% identical safety-critical code. Extract a single helper that takes a PSBT-building callback:

```typescript
async function buildSignBroadcast(
  wallet: Wallet,
  esplora: EsploraClient,
  syncHandle: OnchainSyncHandle | null,
  buildPsbt: (feeRate: FeeRate) => Psbt,
  feeRateSatVb?: bigint, // optional: reuse rate from estimate step
): Promise<string> {
  const resolvedRate = feeRateSatVb ?? await getFeeRate(esplora)
  syncHandle?.pause()
  try {
    const psbt = buildPsbt(new FeeRate(resolvedRate))
    const fee = psbt.fee().to_sat()
    if (fee > MAX_FEE_SATS) {
      wallet.take_staged() // discard
      throw new Error(`Fee too high: ${fee} sats`)
    }
    wallet.sign(psbt, new SignOptions())
    const tx = psbt.extract_tx()
    const txid = tx.compute_txid().toString()
    await esplora.broadcast(tx)
    persistChangeset(wallet) // AFTER broadcast, not before
    return txid
  } finally {
    syncHandle?.resume()
  }
}
```

**Why:** If a bug fix is applied to one send path but not the other, it creates a silent divergence in safety-critical logic.

### 2. Persist Changeset AFTER Broadcast

```
wallet.sign(psbt)
tx = psbt.extract_tx()
await esplora.broadcast(tx)   // if this fails, don't persist
persistChangeset(wallet)       // only persist after success
```

**Why:** If changeset is persisted before broadcast and broadcast fails, the wallet state on disk reflects spent UTXOs for a transaction that was never broadcast. The user sees a lower balance until the next sync corrects it.

### 3. Discard Staged Changes After Fee Estimation

When building a PSBT just to read the fee (estimation), `TxBuilder.finish()` stages wallet changes (UTXO allocation). You must discard them afterward:

```typescript
const psbt = wallet.build_tx().add_recipient(recipient).fee_rate(rate).finish()
const fee = psbt.fee().to_sat()
wallet.take_staged() // discard — this was just an estimate
```

**Why:** Without this, the wallet considers those UTXOs allocated. The subsequent real transaction build may fail with InsufficientFunds or select different UTXOs than expected.

### 4. Pass Fee Rate from Estimate to Send

The user reviews a fee on the review screen. If you re-fetch the fee rate at broadcast time, mempool conditions may have changed:

```typescript
// Estimate step: capture the rate
const { fee, feeRate } = await estimateFee(address, amount)
// Show feeRate to user on review screen

// Send step: reuse the same rate
await sendToAddress(address, amount, feeRate)
```

**Why:** Prevents fee drift between review and broadcast. The user pays exactly what they approved.

### 5. Pause Sync Loop During Send

The background sync loop calls `wallet.apply_update()` every 30 seconds. If `wallet.build_tx()` runs while an update is being applied, async interleaving can corrupt wallet state.

```typescript
syncHandle.pause()
try {
  // build, sign, broadcast
} finally {
  syncHandle.resume()
}
```

The sync loop checks a `paused` boolean each tick and skips if true.

### 6. Double-Submit Prevention with useRef

React state updates are asynchronous. A `useState`-based disabled flag can still allow double-clicks before re-render:

```typescript
const sendingRef = useRef(false)

const handleConfirm = useCallback(async () => {
  if (sendingRef.current) return  // synchronous check
  sendingRef.current = true
  try { /* send */ } finally { sendingRef.current = false }
}, [])
```

**Why:** `useRef` is synchronous — two clicks in the same event loop tick are deduplicated.

### 7. BIP21 Amount Parsing — Fixed-Point, Not Float

Never use `parseFloat` for BTC-to-satoshi conversion. IEEE 754 loses precision for amounts with many significant digits:

```typescript
// WRONG: parseFloat("21000000.00000001") * 1e8 ≠ 2100000000000001
BigInt(Math.round(parseFloat(btcStr) * 1e8))

// CORRECT: fixed-point string parsing
function btcStringToSats(btcStr: string): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(btcStr)) return null
  const [whole, frac = ''] = btcStr.split('.')
  const padded = (frac + '00000000').slice(0, 8)
  return BigInt(whole) * 100_000_000n + BigInt(padded)
}
```

### 8. Don't Expose Raw Wallet on Context

Expose only controlled helper functions (`sendToAddress`, `estimateFee`, etc.), not the raw BDK `Wallet` object. This enforces least-privilege — consumers can't bypass sync pause/resume, fee checks, or changeset persistence.

## Prevention

- Always extract shared helpers for safety-critical code paths (sign, persist, broadcast)
- Always discard staged changes after estimation builds
- Always persist changeset after (not before) broadcast
- Always use fixed-point arithmetic for monetary conversions
- Always use `useRef` (not `useState`) for synchronous guards
- Always pause the sync loop during wallet mutations
