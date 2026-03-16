---
title: "feat: Unified spendable balance with auto-routing"
type: feat
status: completed
date: 2026-03-16
---

# feat: Unified Spendable Balance with Auto-Routing

## Overview

Combine onchain (BDK) and Lightning (LDK) balances into a single "total spendable" number on the Home screen, with an always-visible breakdown showing how funds are split across rails. The send flow already auto-routes based on input type (`classifyPaymentInput`) — this plan formalizes that behavior and adds Lightning capacity pre-validation for fixed-amount invoices.

## Problem Statement / Motivation

Currently the Home screen displays only onchain balance (`confirmed + trustedPending`). Lightning outbound capacity is buried in Advanced > Peers, making the wallet feel like an onchain-only experience. Users with funds in channels have no visibility into their Lightning spending power from the main screen. A payments-focused wallet should surface all spendable funds front and center.

## Proposed Solution

### 1. Reactive Lightning Balance in LDK Context

Add a `lightningBalanceSats: bigint` field to the LDK context's `ready` state. Update it every 10 seconds in the existing `peerTimerId` interval, alongside event processing. This makes Lightning balance reactive — React re-renders downstream when capacity changes.

**Why not poll from the component?** Keeps balance computation centralized in the provider (consistent with how `OnchainProvider` handles onchain balance). Avoids N components each running their own poll timers.

### 2. `useUnifiedBalance()` Hook

A thin hook that consumes `useOnchain()` and `useLdk()`, returning:

```typescript
interface UnifiedBalance {
  total: bigint           // onchain spendable + lightning spendable (sats)
  onchain: bigint         // confirmed + trustedPending (sats)
  lightning: bigint       // floor(outboundCapacityMsat / 1000) (sats)
  pending: bigint         // untrustedPending (sats)
  isLoading: boolean      // either provider still loading
}
```

This eliminates the duplicated `confirmed + trustedPending` computation currently in both `Home.tsx` and `Send.tsx`.

### 3. Home Screen Unified Display

Show `total` as the primary balance. When both `onchain > 0` and `lightning > 0`, show a breakdown sub-line: `"₿X onchain · ₿Y lightning"`. When only one rail has funds, no breakdown needed. The `pending` indicator remains as-is for `untrustedPending`.

### 4. Lightning Capacity Pre-Check on Send

For fixed-amount BOLT11 invoices, validate `amountMsat <= outboundCapacityMsat` before entering the review screen. Currently the user can reach "Confirm Send" for an invoice they can't pay, then get a cryptic routing error.

## Technical Considerations

### msat-to-sat Conversion

Use **floor division** (`msat / 1000n`) for balance display — never overstate what's available. The existing `msatToSat` in `Send.tsx` uses ceiling (`(msat + 999n) / 1000n`) for send amounts, which is correct for that context (never understate what you're sending). Create a separate `msatToSatFloor` utility for balance display.

### Balance Reactivity Cadence

| Source | Update Trigger | Cadence |
|--------|---------------|---------|
| Onchain (BDK) | Sync loop polls Esplora | Every 30s |
| Lightning (LDK) | Event processing + capacity recompute | Every 10s |

The unified balance will update at whichever cadence fires. Worst case staleness: 30s for onchain, 10s for Lightning. This is acceptable for a wallet UI.

### Transient Balance Dip During Channel Open

When a channel funding tx is broadcast, onchain balance drops immediately but Lightning capacity doesn't appear until the channel confirms and becomes usable. The unified balance will temporarily decrease by the channel value. **Decision:** Accept this dip. The Peers page already shows channel pending states. Adding a "pending channel" indicator to Home is out of scope.

### Routing Fees Not Reflected in Display

`outboundCapacityMsat()` reports raw outbound capacity. Actual sendable amount is slightly less due to routing fees. A max-capacity Lightning payment will fail at the routing layer. **Decision:** Do not subtract a fee buffer from the displayed balance (it varies per route and would be inaccurate). Instead, improve the error message when a payment fails due to insufficient routing fees.

### Channel Reserve

LDK's `get_outbound_capacity_msat()` already deducts the channel reserve (typically 1% of channel value). No additional adjustment needed.

## System-Wide Impact

- **Interaction graph**: `useUnifiedBalance()` reads from `OnchainContext` and `LdkContext`. No writes, no side effects. The new `lightningBalanceSats` field in LDK context triggers re-renders for any component consuming `useLdk()` — but since it updates at the same 10s cadence as existing event processing (which already touches `nodeRef`), this adds minimal overhead.

- **Error propagation**: No new error paths. The hook returns `isLoading: true` when either provider is loading, and defaults balances to `0n`. Existing error handling in providers is unchanged.

- **State lifecycle risks**: None. The hook is pure derived state. The only new persisted state is `lightningBalanceSats` in React context memory (not IndexedDB). If LDK crashes, the context goes to error state and `useUnifiedBalance` returns `isLoading: true`.

- **API surface parity**: `outboundCapacityMsat()` function remains available for direct use in `Send.tsx`. The new `lightningBalanceSats` is an additional convenience field, not a replacement.

- **Integration test scenarios**:
  1. Open a channel → verify unified balance eventually reflects the new outbound capacity
  2. Send a Lightning payment → verify unified balance decreases by the payment amount
  3. Close a channel → verify Lightning balance drops and onchain balance eventually increases after sweep
  4. Fresh wallet with no channels → verify unified balance equals onchain balance only

## Acceptance Criteria

### Functional

- [x] Home screen shows a single total balance: `onchain (confirmed + trustedPending) + lightning (floor of outboundCapacityMsat / 1000)`
- [x] When both onchain and lightning balances are > 0, a breakdown line shows below: `"₿X onchain · ₿Y lightning"`
- [x] When only one rail has funds, no breakdown is shown (just the total)
- [x] Lightning balance updates reactively (within 10s of capacity changes)
- [x] Pasting a fixed-amount BOLT11 invoice that exceeds Lightning capacity shows an error on the input screen, not after reaching the review screen
- [x] `useUnifiedBalance()` hook is used in both Home.tsx and Send.tsx (eliminates duplicated balance math)
- [x] Balance hide/show toggle also hides the breakdown line
- [x] Send flow continues to auto-route based on input type (already implemented via `classifyPaymentInput`)
- [x] Rail-specific "available" labels on send amount screens remain unchanged (show per-rail balance, not unified)

### Non-Functional

- [x] No additional network requests (Lightning balance is derived from in-memory LDK state)
- [x] No additional IndexedDB writes
- [x] Unit tests for `useUnifiedBalance()` hook covering: both rails funded, one rail zero, both zero, loading states
- [x] Unit tests for `msatToSatFloor` utility
- [x] Updated Home.test.tsx and Send.test.tsx for unified balance display and capacity pre-check

## Success Metrics

- User sees all spendable funds on the Home screen without navigating to Advanced settings
- No user confusion bug reports about "missing" Lightning balance
- Send validation catches insufficient Lightning capacity before the review screen

## Dependencies & Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Users confused that unified balance isn't spendable in one tx | Medium | Always-visible breakdown makes the split clear; per-rail validation on send screens shows actual available |
| Lightning balance staleness (up to 10s) | Low | Acceptable for wallet UX; could add manual refresh later |
| Re-renders from new `lightningBalanceSats` state | Low | Same cadence as existing event processing; only components consuming `useLdk()` are affected |

## Implementation Guide

### File Changes

#### New Files

- `src/hooks/use-unified-balance.ts` — the `useUnifiedBalance()` hook
- `src/utils/msat.ts` — `msatToSatFloor()` utility
- `src/hooks/use-unified-balance.test.ts` — hook tests
- `src/utils/msat.test.ts` — conversion tests

#### Modified Files

- `src/ldk/ldk-context.ts` — add `lightningBalanceSats: bigint` to `LdkContextReady` type
- `src/ldk/context.tsx` — compute and set `lightningBalanceSats` in the 10s interval
- `src/pages/Home.tsx` — replace inline balance math with `useUnifiedBalance()`, add breakdown sub-line
- `src/pages/Home.test.tsx` — update tests for unified balance display
- `src/components/BalanceDisplay.tsx` — add optional `breakdown` prop (string to show below main balance)
- `src/pages/Send.tsx` — use `useUnifiedBalance()` for balance references; add capacity pre-check for fixed-amount BOLT11
- `src/pages/Send.test.tsx` — add tests for capacity pre-check

### Implementation Order

1. **`msatToSatFloor` utility + tests** — standalone, no dependencies
2. **Add `lightningBalanceSats` to LDK context** — type change + provider update in 10s interval
3. **`useUnifiedBalance()` hook + tests** — depends on step 2
4. **Update `BalanceDisplay`** — add `breakdown` prop
5. **Update `Home.tsx`** — use hook, pass breakdown to BalanceDisplay
6. **Update `Send.tsx`** — use hook for balance refs, add BOLT11 capacity pre-check
7. **Update component tests** — Home.test.tsx, Send.test.tsx

### Key Code Sketches

#### `src/utils/msat.ts`

```typescript
/** Convert millisatoshis to satoshis using floor division (never overstates) */
export function msatToSatFloor(msat: bigint): bigint {
  return msat / 1000n
}
```

#### `src/hooks/use-unified-balance.ts`

```typescript
import { useOnchain } from '../onchain/use-onchain'
import { useLdk } from '../ldk/use-ldk'

export interface UnifiedBalance {
  total: bigint
  onchain: bigint
  lightning: bigint
  pending: bigint
  isLoading: boolean
}

export function useUnifiedBalance(): UnifiedBalance {
  const onchain = useOnchain()
  const ldk = useLdk()

  const isLoading = onchain.status === 'loading' || ldk.status === 'loading'

  const onchainBalance =
    onchain.status === 'ready'
      ? onchain.balance.confirmed + onchain.balance.trustedPending
      : 0n

  const lightningBalance =
    ldk.status === 'ready' ? ldk.lightningBalanceSats : 0n

  const pending =
    onchain.status === 'ready' ? onchain.balance.untrustedPending : 0n

  return {
    total: onchainBalance + lightningBalance,
    onchain: onchainBalance,
    lightning: lightningBalance,
    pending,
    isLoading,
  }
}
```

#### LDK Context Update (`src/ldk/context.tsx` — in the 10s interval)

```typescript
// Inside the existing setInterval callback, after event processing:
const capacityMsat = node.channelManager
  .list_usable_channels()
  .reduce((sum, ch) => sum + ch.get_outbound_capacity_msat(), 0n)
const newBalanceSats = capacityMsat / 1000n

// Only update state if changed (avoid unnecessary re-renders)
if (newBalanceSats !== lightningBalanceSatsRef.current) {
  lightningBalanceSatsRef.current = newBalanceSats
  setState(prev => prev.status === 'ready'
    ? { ...prev, lightningBalanceSats: newBalanceSats }
    : prev
  )
}
```

#### Home.tsx Breakdown

```typescript
const { total, onchain, lightning, pending, isLoading } = useUnifiedBalance()

const breakdown =
  onchain > 0n && lightning > 0n
    ? `${formatBtc(onchain)} onchain · ${formatBtc(lightning)} lightning`
    : undefined

// Pass to BalanceDisplay
<BalanceDisplay balance={total} pending={pending} breakdown={breakdown} />
```

#### Send.tsx BOLT11 Capacity Pre-Check

```typescript
// Before transitioning to ln-review for fixed-amount invoices:
if (parsed.amountMsat && parsed.amountMsat > lnCapacityMsat) {
  setStep({
    type: 'input',
    error: 'Amount exceeds Lightning channel capacity',
  })
  return
}
```

## Sources & References

- Similar pattern: `src/onchain/context.tsx` — reactive balance via sync loop callback
- Balance display: `src/components/BalanceDisplay.tsx` — existing component to extend
- Input classification: `src/ldk/payment-input.ts` — `classifyPaymentInput()`
- Existing msat conversion: `src/pages/Send.tsx:71-73` — ceiling-based `msatToSat`
- LDK outbound capacity: `src/ldk/context.tsx:274-280` — current non-reactive implementation
- Documented learning: `docs/solutions/integration-issues/ldk-wasm-u128-bigint-overflow.md` — bigint safety for WASM
- Documented learning: `docs/solutions/integration-issues/bdk-changeset-delta-persistence-network-type-loss.md` — changeset merge pattern (relevant if adding post-send sync trigger later)
