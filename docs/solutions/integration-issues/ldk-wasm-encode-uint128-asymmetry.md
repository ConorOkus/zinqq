---
title: LDK WASM encodeUint128/decodeUint128 asymmetry causes channel open failure
category: integration-issues
date: 2026-03-16
severity: high
tags: [ldk, wasm, uint128, bigint, signer-provider, channel-open]
modules:
  [src/ldk/traits/bdk-signer-provider.ts, src/ldk/traits/event-handler.ts, src/ldk/context.tsx]
---

# LDK WASM encodeUint128/decodeUint128 Asymmetry

## Problem

Channel open failed with "U128s cannot exceed 128 bits" followed by a WASM panic "already borrowed: BorrowMutError". The error appeared intermittent — it depended on the random bits in `user_channel_id`.

## Root Cause

The LDK WASM JavaScript bindings have an **encode/decode asymmetry** for u128 values:

- **`decodeUint128`**: Reads all 16 bytes big-endian → can produce values up to 2^128-1
- **`encodeUint128`**: Rejects values >= `0x10000000000000000000000000000000n` (which is **2^124**, not 2^128 — the hex literal has 31 zero digits after the leading 1)

When a custom `SignerProvider` delegates `generate_channel_keys_id` to the default provider, the flow is:

1. WASM calls JS callback with `user_channel_id` as encoded u128 bytes
2. `decodeUint128` reads it → BigInt value (potentially > 2^124)
3. Custom impl calls `defaultProvider.generate_channel_keys_id()`
4. Default provider calls `bindings.encodeUint128(user_channel_id)` → **throws** if value >= 2^124

The "already borrowed: BorrowMutError" panic is a cascading failure — the u128 error corrupts WASM's internal RefCell state.

## Solution

Don't delegate `generate_channel_keys_id` through the default provider's JS wrapper. Instead, derive the channel keys ID deterministically from the raw `user_channel_id` BigInt via HMAC-SHA256, without ever passing it back through `encodeUint128` (`src/ldk/traits/bdk-signer-provider.ts` ~43-67):

```typescript
generate_channel_keys_id(inbound: boolean, user_channel_id: bigint): Uint8Array {
  // Deterministic derivation from a purpose-specific HMAC key + channel
  // parameters for cross-device recovery. The HMAC key was derived at init
  // time as HMAC-SHA256(seed, "zinq/channel_keys_id/v1"), so the master seed
  // is not held in this closure.
  //
  // WASM u128 note: We operate on the raw BigInt value directly rather than
  // re-encoding through LDK's encodeUint128 (which rejects values >= 2^124).
  const data = new Uint8Array(1 + 16) // inbound + user_channel_id
  data[0] = inbound ? 1 : 0
  const view = new DataView(data.buffer)
  view.setBigUint64(1, user_channel_id & 0xffffffffffffffffn, false)
  view.setBigUint64(9, user_channel_id >> 64n, false)

  return hmac(sha256, channelKeyHmacKey, data)
}
```

Determinism here is now a **hard requirement**, not a nicety: cross-device VSS recovery must re-derive the exact same `channel_keys_id` for a given channel from the seed alone, with no persisted-state lookup available. Random `channel_keys_id` generation (as an earlier version of this code did) is incompatible with that recovery path — a freshly-restored device would generate a different key ID than the original device used, and `derive_channel_signer` / `get_destination_script` would derive the wrong keys and scripts for existing channels.

The still-true core avoidance rule: never re-encode a decoded u128 through `encodeUint128` — operate on the raw BigInt instead. This is called out directly in the code comment at `src/ldk/traits/bdk-signer-provider.ts` ~59-65.

## Prevention

- **Never re-encode a decoded u128 through the LDK WASM bindings** — the decode produces values the encode rejects
- When implementing custom `SignerProvider` or other LDK trait wrappers, avoid delegating methods that pass u128 parameters through the JS wrapper layer
- If you must delegate, cap the value: `value & ((1n << 124n) - 1n)` before passing to the default provider
- If the derivation must be deterministic (e.g. for cross-device recovery), derive from the raw BigInt via HMAC/hashing rather than generating random bytes — see `src/ldk/traits/bdk-signer-provider.ts`

## Related incident: user_channel_id overflow

A related but distinct bug: generating `user_channel_id` itself from 16 random bytes (reduced via bit-shifting into a BigInt) can produce values that `encodeUint128` rejects. The fix is to generate `user_channel_id` with **8 random bytes (64 bits), not 16**, to stay safely under the encode boundary. 64 bits of randomness is more than sufficient collision resistance for a channel ID.

Call sites using this pattern: `src/ldk/traits/event-handler.ts` ~769-770 (accepting inbound 0-conf channels from the trusted LSP) and `src/ldk/context.tsx` ~710-711 (`createChannel`).

```typescript
// Generate user_channel_id with 8 random bytes (not 16) to avoid u128 encoding bug
const randomBytes = new Uint8Array(8)
crypto.getRandomValues(randomBytes)
const userChannelId = randomBytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n)
```

**Clarification on "the u128 boundary":** in this codebase, "the u128 boundary" refers to the buggy `encodeUint128` cutoff at `0x10000000000000000000000000000000n` — which is **2^124**, not 2^128 (the hex literal has 31 zero digits after the leading `1`, i.e. 124 bits). This has been verified directly against the installed bindings in `node_modules/lightningdevkit/bindings.mjs` ~119-121:

```javascript
export function encodeUint128(inputVal) {
    if (inputVal >= 0x10000000000000000000000000000000n)
        throw "U128s cannot exceed 128 bits";
    ...
```

The thrown error message ("cannot exceed 128 bits") is misleading — the real cutoff is 2^124. Don't reason about this bug in terms of the mathematical 2^128 u128 limit; reason about it in terms of this specific 2^124 implementation bug.
