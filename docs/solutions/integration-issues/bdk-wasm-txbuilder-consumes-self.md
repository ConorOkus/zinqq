---
title: BDK WASM TxBuilder Methods Consume Self
module: src/onchain
severity: HIGH
symptom: "null pointer passed to rust" WASM panic
root_cause: wasm-bindgen ownership semantics
---

# BDK WASM TxBuilder Methods Consume Self

## Symptom

Runtime error: `"null pointer passed to rust"` when calling multiple `TxBuilder` methods sequentially.

## Root Cause

BDK WASM's `TxBuilder` methods (`add_recipient`, `fee_rate`, `drain_wallet`, `drain_to`, `finish`, etc.) take ownership of `self` in Rust. The wasm-bindgen JS wrapper calls `this.__destroy_into_raw()` on every method call, which sets `this.__wbg_ptr = 0`. The method returns a **new** `TxBuilder` wrapper with a fresh pointer.

If you call a second method on the original variable, `__wbg_ptr` is already 0, causing a null pointer panic in Rust.

## Wrong Pattern

```typescript
const txBuilder = wallet.build_tx()
txBuilder.add_recipient(recipient)     // consumes txBuilder, returns new builder (discarded!)
txBuilder.fee_rate(new FeeRate(1n))    // ❌ txBuilder.__wbg_ptr is 0 → WASM panic
const psbt = txBuilder.finish()
```

## Correct Pattern

```typescript
// Chain all calls — each method's return value feeds the next
const psbt = wallet
  .build_tx()
  .add_recipient(recipient)
  .fee_rate(new FeeRate(1n))
  .finish()
```

## Additional Notes

- `add_recipient` also consumes the `Recipient` argument (`__destroy_into_raw()`)
- `drain_to` consumes the `ScriptBuf` argument
- `fee_rate` consumes the `FeeRate` argument
- This applies to ALL `TxBuilder` methods, not just the ones listed above
- The same ownership pattern applies to other BDK WASM builder types

## Related Fix

After calling `finish()` for estimation purposes (without intending to broadcast), call `wallet.take_staged()` to discard the staged changeset. Otherwise the wallet will consider those UTXOs allocated when you build the real transaction.
