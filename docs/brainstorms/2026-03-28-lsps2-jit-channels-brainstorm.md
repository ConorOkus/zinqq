# Brainstorm: LSPS2 / bLIP-52 JIT Channel Support

**Date:** 2026-03-28
**Status:** Draft

## What We're Building

LSPS2 (bLIP-52) client support for zinqq, enabling users with **zero existing channels** to receive their first Lightning payment. When someone pays a zinqq user, the configured LSP intercepts the payment, opens a JIT (Just-In-Time) channel, and forwards the payment minus an opening fee.

This is the key UX unlock for new wallets -- no on-chain funding or manual channel management required.

### Core Flow

1. User wants to receive a payment but has no inbound liquidity
2. zinqq automatically calls `lsps2.get_info` to get the LSP's fee menu
3. zinqq calls `lsps2.buy` with chosen fee params (and optionally payment size)
4. LSP returns a virtual `jit_channel_scid`
5. zinqq generates a BOLT11 invoice with a route hint pointing through the LSP using that SCID
6. Payer sends payment; LSP intercepts it, opens a 0-conf channel to zinqq, forwards payment minus fee
7. zinqq accepts the inbound channel (from known LSP) and claims the payment

### Modes Supported

- **Fixed-amount invoices (MPP):** User specifies amount, invoice has amount, multi-part payments allowed
- **Variable-amount invoices (no-MPP):** Zero-amount invoice, sender decides amount, no MPP

## Why This Approach

### Approach: Lean TypeScript CustomMessageHandler Bridge

Implement a `CustomMessageHandler` in TypeScript that handles LSPS JSON-RPC message serialization/routing over BOLT8 (message type 37913), and delegates to existing WASM `LSPS2ClientHandler` structs where available.

**Why this over alternatives:**

- **vs. waiting for upstream `LiquidityManager` WASM export:** Unblocks us today. The individual LSPS2 structs exist in the WASM bindings but `LiquidityManager` (which normally composes them) is not exported. We bridge the gap in TypeScript.
- **vs. full TypeScript LSPS2 client:** Less code, uses battle-tested Rust types for fee params/validation, easier migration path when `LiquidityManager` is eventually exported.

**Migration note:** When LDK WASM bindings export `LiquidityManager`, replace the TypeScript bridge with `LiquidityManager.as_CustomMessageHandler()`. The rest of the integration (context, UI, event handling) stays the same.

## Key Decisions

1. **TypeScript bridge now, upstream later** -- Build a CustomMessageHandler in TS that routes LSPS messages to WASM LSPS2 structs. Switch to `LiquidityManager` when it's exported in WASM bindings.

2. **LSP trusts client model** -- The LSP broadcasts the funding tx first. zinqq can wait for confirmations before releasing the preimage. Safer for the user.

3. **Both invoice modes** -- Support fixed-amount (MPP) and variable-amount (no-MPP) invoices for full spec coverage.

4. **Automatic JIT on receive** -- When the user has no inbound liquidity and tries to receive, automatically use LSPS2. No explicit opt-in required. Seamless onboarding UX.

5. **Accept inbound channels from configured LSP** -- The `Event_OpenChannelRequest` handler (currently ignoring all inbound) needs to accept channels from the configured LSP's node ID.

## Integration Points

| Component         | File                              | Change Needed                                                           |
| ----------------- | --------------------------------- | ----------------------------------------------------------------------- |
| PeerManager init  | `src/ldk/init.ts`                 | Replace `IgnoringMessageHandler` with LSPS-aware `CustomMessageHandler` |
| Event handler     | `src/ldk/traits/event-handler.ts` | Accept inbound `OpenChannelRequest` from LSP node ID                    |
| LDK context       | `src/ldk/context.tsx`             | Expose LSPS2 operations (request JIT channel, fee params)               |
| Context types     | `src/ldk/ldk-context.ts`          | Add LSPS2 methods and state to `LdkContextValue`                        |
| Config            | `src/ldk/config.ts`               | Add LSP node ID and LSPS2 configuration                                 |
| Receive page      | `src/pages/Receive.tsx`           | Auto-trigger LSPS2 flow when no inbound liquidity                       |
| New: LSPS2 module | `src/ldk/lsps2/`                  | CustomMessageHandler, message serialization, client state machine       |

## Technical Details

### LSPS0 Transport

- All LSPS messages use BOLT8 custom message type **37913**
- Payload is JSON-RPC 2.0 encoded as UTF-8
- Method names prefixed with `lsps2.` (e.g., `lsps2.get_info`, `lsps2.buy`)
- LSP advertises support via feature bit **729** in `node_announcement`

### Opening Fee Calculation

```
opening_fee = ceil(payment_size_msat * proportional / 1_000_000)
if opening_fee < min_fee_msat:
    opening_fee = min_fee_msat
```

All arithmetic uses unsigned 64-bit integers with overflow checking.

### Channel Requirements for JIT Channels

- Must use `option_scid_alias` (reference channel before confirmation)
- `announce_channel` = false (required by `option_scid_alias`)
- LSP sends `extra_fee` TLV (type 65537, per bLIP-25) on forwarded HTLCs

### Error Codes (LSPS2 range: 200-299)

- 200: `unrecognized_or_stale_token`
- 201: `invalid_opening_fee_params`
- 202: `payment_size_too_small`
- 203: `payment_size_too_large`
- 1: `client_rejected`

## Open Questions

1. **Which LSP on mutinynet/signet supports LSPS2?** User has one in mind -- need the specific node ID and connection details for config.

2. **WASM LSPS2ClientHandler API surface** -- Need to verify exactly which methods/types are usable on the WASM-exported `LSPS2ClientHandler` before deciding how much of the protocol the bridge needs to handle vs. delegate. This is the first task in implementation.

## Resolved Questions

3. **0-conf channel acceptance policy** -- Accept 0-conf channels from the configured LSP immediately. The "LSP trusts client" model already protects the user (LSP broadcasts funding tx first). Best UX -- payment completes instantly.

4. **Fee display UX** -- Show the opening fee as informational text when generating the invoice, but don't require explicit user confirmation. Low friction, transparent.
