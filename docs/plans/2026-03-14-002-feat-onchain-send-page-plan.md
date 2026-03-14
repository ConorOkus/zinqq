---
title: "feat: Add on-chain send page with BIP21 support"
type: feat
status: completed
date: 2026-03-14
origin: docs/brainstorms/2026-03-14-onchain-send-brainstorm.md
---

# feat: Add on-chain send page with BIP21 support

## Overview

Add a `/send` page that lets users send bitcoin onchain from their BDK wallet. Two-step flow: input (address + amount) → review (fee + total) → broadcast. Supports BIP21 URI paste and send-max (drain wallet).

## Problem Statement / Motivation

The wallet can receive onchain funds and open Lightning channels, but has no way to send onchain. This is a core wallet capability needed for withdrawals and onchain payments.

## Proposed Solution

Extend the `OnchainContext` with send and fee-estimation helpers, then build a `Send` page component that consumes them. The page manages a multi-step local state machine (input → review → broadcasting → success/error). (See brainstorm: `docs/brainstorms/2026-03-14-onchain-send-brainstorm.md`)

### OnchainContext Extension

Add to the `'ready'` variant of `OnchainContextValue`:

```typescript
// src/onchain/onchain-context.ts — ready variant additions
estimateFee: (address: string, amountSats: bigint) => Promise<{ fee: bigint; feeRate: bigint }>
estimateMaxSendable: (address: string) => Promise<{ amount: bigint; fee: bigint; feeRate: bigint }>
sendToAddress: (address: string, amountSats: bigint) => Promise<string>  // returns txid
sendMax: (address: string) => Promise<string>  // returns txid
```

These helpers close over the `wallet`, `esploraClient`, and `putChangeset` inside the `OnchainProvider`, avoiding exposing BDK internals to page components.

### Transaction Pipeline (inside context helpers)

```
1. Fetch fee rate:  esploraClient.get_fee_estimates() → .get(6) → FeeRate
2. Build tx:        wallet.build_tx() → .add_recipient() / .drain_wallet().drain_to() → .fee_rate() → .finish() → Psbt
3. Sign:            wallet.sign(psbt, new SignOptions())
4. Persist:         wallet.take_staged() → putChangeset(staged.to_json())
5. Broadcast:       esploraClient.broadcast(psbt.extract_tx())
6. Return txid:     psbt.extract_tx().compute_txid()
```

### Send Page State Machine

```
type SendStep =
  | { step: 'input' }
  | { step: 'reviewing'; address: string; amount: bigint; fee: bigint; feeRate: bigint; isSendMax: boolean }
  | { step: 'broadcasting' }
  | { step: 'success'; txid: string }
  | { step: 'error'; message: string; canRetry: boolean }
```

State is local to the `Send` component (consistent with Receive page pattern).

## Technical Considerations

### Broadcasting: Native BDK path vs tx-bridge

Use `esploraClient.broadcast(psbt.extract_tx())` — the native BDK WASM path. This avoids the `@scure/btc-signer` workaround in `tx-bridge.ts`, which exists only because LDK needs raw bytes and BDK lacks `Transaction.to_bytes()`. The send flow doesn't need raw bytes — `EsploraClient.broadcast()` accepts a `Transaction` object directly.

### Changeset Persistence (Critical)

After `wallet.sign(psbt)`, immediately call `wallet.take_staged()` and persist via `putChangeset(staged.to_json())` **before** broadcasting. `take_staged()` is destructive — if persistence fails, log a `[Onchain] CRITICAL` error (consistent with existing pattern in `src/ldk/traits/event-handler.ts:267`). If the browser crashes after sign but before broadcast, the UTXOs appear spent locally but aren't broadcast — the next full sync from Esplora will correct this.

### Sync Loop Concurrency

The background sync loop (`src/onchain/sync.ts`) calls `wallet.apply_update()` every 30 seconds. BDK WASM runs single-threaded, but async interleaving could cause issues if `wallet.build_tx()` runs while an update is being applied. **Mitigation:** Add a `pauseSync` / `resumeSync` mechanism to the OnchainProvider. The send helpers pause the sync loop before building, and resume after changeset persistence. This can be a simple boolean ref checked by the sync loop's `setInterval` callback.

### Fee Estimation

- Fetch via `esploraClient.get_fee_estimates()` with a 6-block confirmation target
- `FeeEstimates.get(6)` returns `number` (sat/vB) — convert to `bigint` for `new FeeRate()`
- Display the actual fee from `psbt.fee()` (an `Amount`) on the review screen, not a pre-build estimate
- **Fallback:** If `get_fee_estimates()` fails, use 1 sat/vB (signet fees are negligible)
- **Safety guard:** After building, check `psbt.fee()` does not exceed a sanity limit (e.g., 50,000 sats). If it does, refuse to sign and show an error.

### BIP21 URI Parsing

Simple custom parser — no library needed. BIP21 is just `bitcoin:<address>?amount=<btc>&label=...`:

```typescript
// src/onchain/bip21.ts
export function parseBip21(input: string): { address: string; amountSats?: bigint } | null {
  if (!input.toLowerCase().startsWith('bitcoin:')) return null
  const url = new URL(input.replace(/^bitcoin:/i, 'bitcoin://'))
  const address = url.pathname.replace('//', '')
  const amountBtc = url.searchParams.get('amount')
  const amountSats = amountBtc ? BigInt(Math.round(parseFloat(amountBtc) * 1e8)) : undefined
  return { address, amountSats }
}
```

Detect on paste event: if input starts with `bitcoin:`, parse and auto-fill. Ignore unknown parameters (`label`, `message`, `lightning`). If send-max is toggled on, it overrides any BIP21 amount.

### Address Validation

Use `Address.from_string(address, 'signet')` from BDK WASM (see brainstorm). This validates format and network. Catch and map errors:

| BDK Error | User Message |
|---|---|
| Network validation | "This address is for a different Bitcoin network" |
| Parse error | "Invalid Bitcoin address" |

Validate on blur of the address input and before building the transaction.

### Amount Validation

- **Minimum:** 294 sats (P2WPKH dust limit). Validate on the input step with inline error.
- **Maximum:** Compare against `balance.confirmed` for the input step display. BDK's `TxBuilder.finish()` will throw `InsufficientFunds` with `needed` and `available` fields if the actual build fails.
- **Zero/empty:** Block with "Enter an amount" message.
- **Non-numeric input:** Use `<input type="number">` with step="1" to prevent non-integer entry.

### Error Handling

Catch BDK errors during the build-sign-broadcast pipeline and map to user messages:

| Error | Message | Recovery |
|---|---|---|
| `InsufficientFunds` | "Insufficient funds. Available: {available} sats, needed: {needed} sats" | Back to input |
| Address validation | "Invalid address" / "Wrong network" | Stay on input |
| `OutputBelowDustLimit` | "Amount is below the minimum (294 sats)" | Stay on input |
| Fee estimation failure | Silent fallback to 1 sat/vB | Continue |
| Broadcast failure | "Broadcast failed: {message}. Your funds are safe." | Retry from review |
| WASM panic | "Something went wrong. Please try again." | Back to input |

### Double-Click Prevention

The `broadcasting` step disables the confirm button and shows a spinner. The `sendToAddress` / `sendMax` helpers are not idempotent (they mutate wallet state), so preventing double invocation is critical.

## System-Wide Impact

- **OnchainContext:** Extended with 4 new functions on the `'ready'` variant. No breaking changes — existing consumers unaffected.
- **Sync loop:** New pause/resume mechanism. Low risk — only engaged during active send flow.
- **Router:** New `/send` route added.
- **Layout nav:** New "Send" link.
- **Home page:** New "Send" link alongside existing "Receive" link.

## Acceptance Criteria

### Core Send Flow
- [x] User can navigate to `/send` from Home page and nav bar
- [x] User can enter a destination address and amount in sats
- [x] User can toggle "send max" to drain the entire wallet balance
- [x] Review step shows: recipient address, amount, fee (sats), total, and fee rate (sat/vB)
- [x] User can go back from review to edit inputs (values preserved)
- [x] On confirm, transaction is built, signed, persisted, and broadcast
- [x] Success screen displays txid linked to `https://mutinynet.com/tx/{txid}`
- [x] Navigation from success screen back to Home

### BIP21 Support
- [x] Pasting a `bitcoin:address?amount=X` URI auto-fills address and amount
- [x] Pasting a `bitcoin:address` URI (no amount) auto-fills only the address
- [x] Plain address paste works normally

### Validation & Errors
- [x] Invalid address shows "Invalid Bitcoin address" inline error
- [x] Wrong-network address shows "This address is for a different Bitcoin network"
- [x] Amount below dust (294 sats) shows inline error
- [x] Amount exceeding balance shows inline error
- [x] Insufficient funds at build time shows specific message with available/needed
- [x] Broadcast failure shows error with retry option
- [x] Fee estimation failure silently falls back to 1 sat/vB

### Context & Infrastructure
- [x] `OnchainContextValue` ready variant exposes `estimateFee`, `estimateMaxSendable`, `sendToAddress`, `sendMax`
- [x] Changeset is persisted after signing, before broadcast
- [x] Sync loop paused during build-sign-broadcast, resumed after
- [x] Confirm button disabled during broadcast (double-click prevention)
- [x] Fee sanity check rejects unreasonable fees (>50,000 sats)

### Testing
- [x] Unit tests for BIP21 parser (`src/onchain/bip21.ts`)
- [x] Send page tests: loading, error, and ready states
- [x] Send page tests: input validation (invalid address, dust amount, exceeds balance)
- [x] Send page tests: review step displays correct values
- [x] Send page tests: success and error states after broadcast

## Files to Create/Modify

### New Files
- `src/onchain/bip21.ts` — BIP21 URI parser
- `src/onchain/bip21.test.ts` — BIP21 parser tests
- `src/pages/Send.tsx` — Send page component
- `src/pages/Send.test.tsx` — Send page tests

### Modified Files
- `src/onchain/onchain-context.ts` — Add send/fee functions to ready variant
- `src/onchain/context.tsx` — Implement send/fee helpers, sync pause/resume
- `src/onchain/sync.ts` — Accept pause/resume controls
- `src/routes/router.tsx` — Add `/send` route
- `src/components/Layout.tsx` — Add "Send" nav link
- `src/pages/Home.tsx` — Add "Send" link alongside "Receive"

## Success Metrics

- User can send a signet transaction end-to-end (input → review → broadcast → success with txid)
- Transaction appears on mutinynet block explorer after broadcast
- Balance updates within 30 seconds (or immediately if `apply_unconfirmed_txs` is used)

## Dependencies & Risks

- **BDK WASM `EsploraClient.broadcast()`**: Not yet used in the codebase — needs verification that it works with `psbt.extract_tx()` output. If it doesn't, fall back to `tx-bridge.ts` pattern.
- **Fee estimation on signet**: Mutinynet fee estimates may return 0 or very low values. The 1 sat/vB fallback handles this.
- **`FeeEstimates.get()` return type**: The BDK WASM typings show `get(k: number): number | undefined`. Need to handle `undefined` (target not available).

## Sources & References

- **Origin brainstorm:** [docs/brainstorms/2026-03-14-onchain-send-brainstorm.md](docs/brainstorms/2026-03-14-onchain-send-brainstorm.md) — Key decisions: two-step flow, extend OnchainContext, BIP21 paste, send max, fetched fee estimates, specific errors
- **Institutional learnings:** `docs/solutions/integration-issues/bdk-ldk-cross-wasm-transaction-bridge.md` — tx-bridge workaround context, broadcast patterns
- **Institutional learnings:** `docs/solutions/integration-issues/bdk-wasm-onchain-wallet-integration-patterns.md` — changeset persistence, context structure, provider patterns
- **Reference implementation:** `src/ldk/traits/event-handler.ts:214-272` — build_tx/sign/broadcast pattern for channel funding
- **UI reference:** `src/pages/Receive.tsx` — page structure, context consumption, state handling
- **Test reference:** `src/pages/Receive.test.tsx` — testing patterns with context mocking
