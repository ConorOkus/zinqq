---
title: 'feat: Force Close Recovery UX'
type: feat
status: completed
date: 2026-04-14
origin: docs/brainstorms/2026-04-14-force-close-recovery-ux-brainstorm.md
---

# feat: Force Close Recovery UX

## Overview

When a Lightning channel force closes and the automated anchor CPFP fee bump fails due to insufficient on-chain funds, the user's balance silently disappears with no explanation. This is especially painful for Lightning-only users (LSPS2 JIT receivers) who have no on-chain UTXOs to fund the fee bump.

This plan implements a recovery UX: a persistent home-screen banner that guides non-technical users through depositing a small amount of on-chain bitcoin to unstick their funds, with fully automatic recovery once the deposit arrives.

## Problem Statement / Motivation

1. User receives via LSPS2 JIT channels — never touches on-chain bitcoin
2. Channel force closes (counterparty-initiated, connectivity issue, etc.)
3. `BumpTransactionEventHandler` attempts CPFP but fails — `BdkWalletSource.list_confirmed_utxos()` returns empty
4. `sweepSpendableOutputs` also fails — `spend_spendable_outputs` returns error for dust/timelocked outputs
5. Both failures are logged via `captureError` but produce **zero user-facing feedback**
6. User sees balance drop to zero with no explanation

The LSP cannot be relied on to CPFP on their side — observed in production. The current `ANCHOR_RESERVE_SATS = 10_000n` only prevents _spending below_ that threshold; it doesn't _create_ the reserve for Lightning-only users.

(see brainstorm: `docs/brainstorms/2026-04-14-force-close-recovery-ux-brainstorm.md` — "Why This Approach" section)

## Proposed Solution

### State Machine

The recovery flow has six states:

```
idle → needs_recovery → deposit_shown → deposit_detected → sweep_confirmed → dismissed
```

| State              | Trigger                                 | UI                                | Persisted       |
| ------------------ | --------------------------------------- | --------------------------------- | --------------- |
| `idle`             | Default / recovery complete + dismissed | No banner                         | No              |
| `needs_recovery`   | CPFP fails with insufficient funds      | Warning banner on home            | Yes (VSS + IDB) |
| `deposit_shown`    | User opens recovery screen              | Recovery screen with QR + address | Yes (VSS + IDB) |
| `deposit_detected` | Wallet sync finds new UTXO              | Banner updates: "Recovering..."   | Yes             |
| `sweep_confirmed`  | Sweep tx broadcast succeeds             | Success banner (dismissible)      | Yes             |
| `dismissed`        | User dismisses success banner           | No banner → idle                  | Cleared         |

### Detection: Which closures trigger recovery?

Only force closes produce anchor outputs that need CPFP. Filter `Event_ChannelClosed` by `ClosureReason`:

**Triggers recovery check:**

- `ClosureReason_CounterpartyForceClosed`
- `ClosureReason_CommitmentTxConfirmed`
- `ClosureReason_HolderForceClosed`
- `ClosureReason_HTLCsTimedOut`

**Does NOT trigger:**

- `ClosureReason_LegacyCooperativeClosure`
- `ClosureReason_CounterpartyInitiatedCooperativeClosure`
- `ClosureReason_LocallyInitiatedCooperativeClosure`
- `ClosureReason_FundingTimedOut` (no funds at risk)
- All other variants

After a qualifying close, check if the subsequent `Event_BumpTransaction` or `sweepSpendableOutputs` fails. If it does, transition to `needs_recovery`.

### Recovery State Schema (VSS + IDB)

Key: `force_close_recovery`

```typescript
interface RecoveryState {
  status: 'needs_recovery' | 'deposit_shown' | 'deposit_detected' | 'sweep_confirmed'
  stuckBalanceSat: number // channel local balance at close
  depositAddress: string // stable address for the recovery deposit
  depositNeededSat: number // rounded-up estimate for fee bump
  channelIds: string[] // hex channel IDs (supports multiple force closes)
  createdAt: number // unix timestamp
  updatedAt: number // unix timestamp
}
```

Persisted via the existing dual-write pattern: VSS first (durable remote), then IDB (fast local). Uses the `versionCache` pattern from `src/ldk/traits/persist.ts`.

### Key Design Decisions (from brainstorm)

- **Persistent non-dismissible banner** on home screen (see brainstorm: Decision 1)
- **Calm and reassuring tone** — "Your funds are safe but need a small deposit to unlock" (see brainstorm: Decision 2)
- **BIP 177 formatting** — `₿` + comma-separated integer, no "sats" terminology (see brainstorm: Resolved Question 1)
- **Fully automatic recovery** — no manual confirmation after deposit (see brainstorm: Decision 3)
- **Dynamic fee updates** on each wallet sync, not real-time (see brainstorm: Resolved Question 2)
- **Timelock mentioned upfront** with actual `to_self_delay` from channel, not hardcoded 14 days (see brainstorm: Resolved Question 3)
- **Deposit address is stable** — generated once and persisted with recovery state, not regenerated on each screen visit

## Technical Considerations

### Architecture

Three new layers:

1. **Detection hook** — New callback `onRecoveryNeeded` in `createEventHandler` signature, fired when CPFP fails with insufficient funds
2. **State manager** — `src/ldk/recovery/recovery-state.ts` — reads/writes VSS+IDB, exposes React-consumable state
3. **UI components** — `RecoveryBanner.tsx`, `/recover` route with `RecoverFunds.tsx`

### Implementation Phases

#### Phase 1: Detection & State Management

**Files to modify:**

- `src/ldk/traits/event-handler.ts` — Add `onRecoveryNeeded` callback, detect insufficient-funds CPFP failure, filter force-close ClosureReasons
- `src/ldk/sweep.ts` — Return a richer `SweepResult` that distinguishes "no UTXOs" from other failures

**Files to create:**

- `src/ldk/recovery/recovery-state.ts` — Recovery state manager (read/write VSS+IDB, version cache)
- `src/ldk/recovery/use-recovery.ts` — React hook exposing recovery state + actions

**Detection logic in `event-handler.ts`:**

In `Event_BumpTransaction` handler (line 494), after the catch block, check if the error indicates insufficient funds. The `BumpTransactionEventHandler.handle_event()` throws when `CoinSelectionSource` can't find UTXOs. Catch this specific failure and fire `onRecoveryNeeded`.

In `Event_SpendableOutputs` handler (line 338), check the `SweepResult`. If `swept === 0` and `skipped > 0`, the sweep likely failed due to dust or insufficient fee funds. Cross-reference with the `ldk_spendable_outputs` IDB store to check if descriptors remain un-swept.

In `Event_ChannelClosed` handler (line 309), record the closure reason and local balance. Only flag force-close variants for potential recovery.

**Sweep result enrichment in `sweep.ts`:**

```typescript
export interface SweepResult {
  swept: number
  skipped: number
  txid: string | null
  failureReason?: 'no_utxos' | 'dust_or_timelocked' | 'fee_estimation' | 'broadcast'
}
```

**State persistence pattern:**

Follow the existing `versionCache` + `putObject` pattern. On startup, read recovery state from IDB (fast) and verify against VSS (authoritative). If state exists and `status !== 'dismissed'`, surface the banner immediately.

#### Phase 2: UI — Banner & Recovery Screen

**Files to modify:**

- `src/pages/Home.tsx` — Conditionally render `RecoveryBanner` between `BalanceDisplay` and action buttons

**Files to create:**

- `src/components/RecoveryBanner.tsx` — Warning banner (non-dismissible) and success banner (dismissible)
- `src/pages/RecoverFunds.tsx` — Full recovery screen with QR code, address, amounts, timelock
- Route registration in `src/App.tsx` (or equivalent router config)

**RecoveryBanner.tsx:**

Follows the existing `UpdateBanner.tsx` pattern. Positioned inside the Home component between `BalanceDisplay` and the action buttons div. Uses `bg-black/15` on the accent background for visual consistency.

Two states:

1. **Warning** — non-dismissible, shows "Your funds are safe" + subtitle, taps to `/recover`
2. **Success** — dismissible, shows "Funds recovered!" + timelock estimate

**RecoverFunds.tsx:**

Dark background sub-flow screen (same pattern as Send Review, Close Channel). Sections:

1. Explanation paragraph — calm, no jargon
2. Details card — stuck balance + deposit needed (BIP 177 format)
3. QR code + address pill with copy button (reuse `receive-overlay` patterns)
4. Timelock notice — clock icon + "After recovery, funds will be available in approximately X days" using actual `to_self_delay`

**Design prototype reference:** `design/index.html#recover`, `design/styles.css`, `design/app.js`

#### Phase 3: Auto-Recovery & Lifecycle

**Files to modify:**

- `src/onchain/sync.ts` or the sync callback chain — After each wallet sync, if recovery state is `needs_recovery` or `deposit_shown`, check for new confirmed UTXOs and auto-retry the sweep
- `src/ldk/traits/event-handler.ts` — Startup sweep should also update recovery state on success

**Auto-recovery flow:**

1. On-chain wallet sync completes (`startOnchainSyncLoop` → `onBalanceUpdate`)
2. Check if recovery state exists and is `needs_recovery` or `deposit_shown`
3. If confirmed balance > 0, attempt `sweepSpendableOutputs` again
4. If sweep succeeds → update state to `sweep_confirmed`, show success banner
5. If sweep still fails → update `depositNeededSat` with fresh fee estimate (dynamic update)

**Startup restoration:**

On LDK init, after reading recovery state from IDB:

- If `needs_recovery` or `deposit_shown` → show banner immediately
- If `deposit_detected` or `sweep_confirmed` → show appropriate banner state
- Run startup sweep as usual — if it succeeds and recovery state exists, transition to `sweep_confirmed`

**Multiple force closes:**

If a second force close occurs while recovery is active, aggregate into the existing state: append the channel ID to `channelIds[]`, add to `stuckBalanceSat`, recalculate `depositNeededSat`.

**Partial deposit handling:**

If the user deposits some but not enough, the next wallet sync recalculates `depositNeededSat` based on remaining shortfall. The recovery screen updates to show the new (lower) amount needed.

## System-Wide Impact

- **Interaction graph**: `Event_ChannelClosed` → `onRecoveryNeeded` callback → `RecoveryStateManager.enterRecovery()` → VSS+IDB write → React state update → `RecoveryBanner` renders. On wallet sync: `onBalanceUpdate` → check recovery state → retry sweep → VSS+IDB update → banner state change.
- **Error propagation**: CPFP failures caught in `Event_BumpTransaction` handler (already logged). New: also triggers recovery state. Sweep failures in `sweepSpendableOutputs` already caught and logged. New: returns enriched `failureReason` for UI decision-making.
- **State lifecycle risks**: Recovery state could become stale if funds are recovered on another device or via manual intervention. Mitigation: on each wallet sync, verify that `ldk_spendable_outputs` IDB store still has un-swept descriptors. If empty and recovery state is active, auto-clear to `dismissed`.
- **API surface parity**: No external APIs affected. Internal: adds `onRecoveryNeeded` callback to `createEventHandler`.

## Acceptance Criteria

### Functional Requirements

- [x] Force close with insufficient UTXOs shows persistent banner on home screen within one event loop cycle
- [x] Banner is non-dismissible while funds are stuck; taps through to recovery screen
- [x] Recovery screen shows stuck balance, deposit needed (BIP 177), QR code, copyable address, timelock estimate
- [x] Deposit address is stable — same address shown across screen revisits and app restarts
- [x] After on-chain deposit, fee bump retries automatically on next wallet sync
- [x] Successful sweep clears warning banner and shows dismissible success banner with timelock
- [x] Recovery state persists across app restarts (IDB) and across devices (VSS)
- [x] Multiple simultaneous force closes aggregate into a single recovery flow
- [x] Cooperative closes do NOT trigger the recovery banner
- [x] Dynamic fee update: if fees rise after deposit, recovery screen updates the required amount

### Non-Functional Requirements

- [x] No new external dependencies
- [x] No jargon in user-facing copy (no "UTXO", "anchor", "CPFP", "commitment transaction")
- [x] Recovery state read from IDB on startup (fast) before VSS verification (async)

## Dependencies & Risks

| Risk                                                                            | Likelihood | Impact | Mitigation                                                                                       |
| ------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------ |
| CPFP error message is opaque (can't distinguish "no UTXOs" from other failures) | Medium     | High   | Parse error string from `BumpTransactionEventHandler`; fall back to checking UTXO count directly |
| VSS version conflict on recovery state write                                    | Low        | Medium | Use existing version cache pattern with retry logic                                              |
| Stale recovery state on restored device                                         | Low        | Medium | Verify against `ldk_spendable_outputs` IDB store on each sync                                    |
| Fee spike makes deposited amount insufficient                                   | Medium     | Medium | Dynamic recalculation; pad initial estimate by 50%                                               |

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-04-14-force-close-recovery-ux-brainstorm.md](docs/brainstorms/2026-04-14-force-close-recovery-ux-brainstorm.md) — Key decisions carried forward: recovery UX over prevention (splicing later), persistent non-dismissible banner, calm tone, fully automatic recovery, VSS persistence, BIP 177 formatting.

### Internal References

- Event handler: `src/ldk/traits/event-handler.ts:494-510` (BumpTransaction), `:309-331` (ChannelClosed), `:338-375` (SpendableOutputs)
- Sweep logic: `src/ldk/sweep.ts:39-131`
- UTXO source: `src/ldk/traits/bdk-wallet-source.ts` (list_confirmed_utxos)
- Anchor reserve: `src/onchain/context.tsx:39` (ANCHOR_RESERVE_SATS)
- VSS persistence pattern: `src/ldk/traits/persist.ts` (versionCache + putObject)
- Home screen: `src/pages/Home.tsx`
- Banner pattern: `src/components/UpdateBanner.tsx`
- Error logging: `src/storage/error-log.ts`
- On-chain sync: `src/onchain/sync.ts`
- Closure reasons: `src/ldk/traits/event-handler.ts:628-647`
- Design prototype: `design/index.html`, `design/styles.css`, `design/app.js`

### Institutional Learnings

- VSS version cache must be seeded on startup (see `docs/solutions/logic-errors/vss-version-cache-startup-seeding-fix.md`)
- BDK must init before LDK deserialization for destination scripts to be BDK-tracked
- Anchor channel feerate floor must be ≤ 1000 sat/kW for LSP compatibility
