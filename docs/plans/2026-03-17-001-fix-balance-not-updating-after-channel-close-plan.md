---
title: "fix: Balance not updating after cooperative channel close"
type: fix
status: completed
date: 2026-03-17
---

# fix: Balance not updating after cooperative channel close

After opening a channel, making payments, and performing a cooperative close, the on-chain balance never reflects the returned funds. The user sees their total balance drop by the full channel capacity with no recovery.

## Root Cause

Two compounding bugs:

1. **No BDK sync trigger after channel close.** The `ChannelClosed` event handler (`src/ldk/traits/event-handler.ts:253-267`) only logs and cleans up peers. It never notifies the BDK sync loop to check for the closing transaction. The sync loop runs every 30 seconds with no `syncNow()` capability (`src/onchain/sync.ts:5-9`).

2. **`untrustedPending` excluded from displayed total.** Even when BDK eventually discovers the closing tx, the funds are classified as `untrustedPending` (BDK didn't sign the closing tx — LDK did). The unified balance hook (`src/hooks/use-unified-balance.ts:22-24`) computes `total = confirmed + trustedPending`, explicitly excluding `untrustedPending`. The funds only appear in the subordinate "pending" line, which the user may not notice.

For cooperative close, LDK broadcasts the closing tx directly to the shutdown script address (a BDK wallet address from `get_shutdown_scriptpubkey`). No `SpendableOutputs` event fires — funds go straight to BDK's address. But BDK doesn't know to look for them, and even when it finds them, the UI hides them from the total.

## Acceptance Criteria

- [x] After cooperative channel close, on-chain balance updates within ~10 seconds (not 30+)
- [x] Returned funds appear in the total balance display immediately (as pending, then confirmed)
- [x] `untrustedPending` is included in the total balance in `useUnifiedBalance`
- [x] No WASM concurrency panics from overlapping sync/tx operations
- [x] Existing tests pass; new tests cover `syncNow()` and updated balance calculation

## Context

- **Cooperative close fund path:** LDK negotiates closing tx → broadcasts via `BroadcasterInterface` → output pays to BDK shutdown script address → BDK must discover via Esplora sync
- **BDK "trust" model:** Transactions BDK signed are `trustedPending`; all others are `untrustedPending`. Channel close txs are always "untrusted" from BDK's perspective.
- **Architecture constraint:** `LdkProvider` and `OnchainProvider` are separate React contexts. `OnchainProvider` depends on `LdkProvider` (calls `setBdkWallet`), but not vice versa. The sync trigger needs a bridge similar to the existing `setBdkWalletRef` pattern.

## MVP

### 1. Add `syncNow()` to `OnchainSyncHandle`

### src/onchain/sync.ts

Add a `syncNow()` method that sets a flag to fire the next tick immediately rather than spawning a parallel sync (avoids WASM concurrency issues). Reset the 30s timer after completion. Include retry logic: up to 3 retries at 3-second intervals to handle Esplora indexing delay.

```typescript
export interface OnchainSyncHandle {
  stop: () => void
  pause: () => void
  resume: () => void
  syncNow: () => void
}
```

Implementation approach: add a `syncRequested` flag. In the `tick()` scheduling logic, when `syncRequested` is true, clear the existing timeout and fire `tick()` immediately. After the sync completes, schedule retries (3 retries, 3s apart) to handle Esplora indexing delay. Reset the normal 30s timer after the last retry.

### 2. Include `untrustedPending` in total balance

### src/hooks/use-unified-balance.ts

```typescript
const onchainBalance =
  onchain.status === 'ready'
    ? onchain.balance.confirmed + onchain.balance.trustedPending + onchain.balance.untrustedPending
    : 0n
```

This matches user expectations: "I closed a channel, my balance should reflect those funds." The existing `pending` field continues to show `untrustedPending` separately for transparency.

### 3. Expose sync trigger from OnchainProvider

### src/onchain/context.tsx

Expose `syncNow` via a stable ref (same pattern as `setBdkWalletRef`) so the LDK layer can call it without creating a circular context dependency or re-render loops.

### 4. Wire `ChannelClosed` to trigger BDK sync

### src/ldk/traits/event-handler.ts

Add a new callback parameter `onSyncNeeded?: () => void` to `createEventHandler`. Call it from the `Event_ChannelClosed` handler.

### src/ldk/context.tsx

Wire `onSyncNeeded` to call the onchain `syncNow` ref (passed via a new ref prop or shared ref, similar to `setBdkWalletRef`).

### 5. Tests

### src/hooks/use-unified-balance.test.ts

- Test that `untrustedPending` is now included in `total`
- Test that `pending` still reflects `untrustedPending` separately

### src/onchain/sync.test.ts (new)

- Test `syncNow()` triggers immediate tick
- Test retry logic (3 retries at 3s intervals)
- Test timer reset after `syncNow()` completes

## Out of Scope

- **Force close timelock UX** — force close funds are invisible for hours due to timelock; needs its own solution (activity feed entry, countdown indicator)
- **Sweep retry mechanism** — currently sweep only runs on startup; separate concern
- **Changeset persistence hardening** — fire-and-forget `putChangeset` could fail silently; full scan with gap limit 20 on init is an adequate safety net
- **Browser background tab throttling** — `setTimeout` throttled to 1min+ in background tabs; separate concern

## Sources

- Key files: `src/ldk/traits/event-handler.ts:253-267`, `src/onchain/sync.ts`, `src/hooks/use-unified-balance.ts:22-24`, `src/onchain/context.tsx:288-339`, `src/ldk/traits/bdk-signer-provider.ts:78-94`
- Institutional learnings: `docs/solutions/integration-issues/bdk-ldk-signer-provider-fund-routing.md`, `docs/solutions/logic-errors/bdk-address-reveal-not-persisted.md`
