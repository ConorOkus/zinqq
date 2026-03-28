# Brainstorm: On-Chain Transaction Tracking, Rebroadcast & Fee Bumping

**Date:** 2026-03-27
**Status:** Draft

## What We're Building

A complete on-chain transaction management system that:

1. **Tracks** pending on-chain transactions with confirmation status beyond binary pending/confirmed
2. **Rebroadcasts** unconfirmed transactions periodically until they confirm
3. **Enables RBF** (Replace-By-Fee) signaling on all new sends so they can be fee-bumped later
4. **Provides manual "Speed up"** UI for users to RBF bump stuck transactions
5. **Auto-bumps anchor channel transactions** when LDK requests it via `Event_BumpTransaction`

## Why This Approach

**Problem:** Today, Zinqq has zero post-broadcast transaction management. If a user send doesn't propagate or gets stuck in the mempool, there's no recovery path. LDK's `Event_BumpTransaction` for anchor channels is stubbed out with a TODO, meaning force-close scenarios can't properly resolve.

**Approach:** Layered rollout — three independently shippable layers that build on each other:

- **Layer 1 — Rebroadcast + RBF signaling:** Foundation. Low risk, high value. Enable `enable_rbf()` on all BDK `TxBuilder` calls. Track pending txs. Rebroadcast during BDK sync loop (every 80s). Add broadcast retry for user sends (matching LDK broadcaster's retry pattern).
- **Layer 2 — Manual "Speed up" UI:** User-facing. Show pending tx age and confirmation count. "Speed up" button rebuilds tx at higher fee rate via BDK's RBF capabilities.
- **Layer 3 — Auto anchor bumping:** Implement `Event_BumpTransaction` handler. Use CPFP with BDK UTXOs for anchor channel fee bumping. Automatic since these are time-sensitive LDK-initiated operations.

**Why layered:** This is money-handling code. Each layer is independently testable and shippable. Bugs in fee bumping can lose funds, so incremental delivery with verification at each step is safest.

## Key Decisions

1. **RBF over CPFP for user sends** — Simpler to implement, covers most cases. Just requires `enable_rbf()` at build time and rebuilding at higher fee rate later.
2. **Manual speed-up for user sends, auto for anchor channels** — Users should consent to spending more on fees. But LDK anchor bumps are time-sensitive and must be automatic.
3. **Rebroadcast via BDK sync loop** — Piggyback on the existing 80s BDK sync cycle rather than adding a new polling mechanism. BDK already tracks these transactions.
4. **Add broadcast retry for user sends** — Currently only LDK's broadcaster has retry logic. User sends via `esploraClient.broadcast()` should get similar retry with exponential backoff.

## Scope Per Layer

### Layer 1: Rebroadcast + RBF Signaling

- Enable `enable_rbf()` on user send `TxBuilder` calls only (not LDK funding txs)
- Store raw tx hex for all user sends in IndexedDB (for rebroadcast)
- During BDK sync, identify unconfirmed txs and rebroadcast them
- Add retry logic to user send broadcast (match LDK broadcaster pattern)
- Expose confirmation count from BDK's `chain_position` in `OnchainTransaction` type

### Layer 2: Manual "Speed Up" UI

- Show confirmation count and pending age on transaction detail
- "Speed up" button on pending transactions
- Fee rate picker for replacement transaction
- Build replacement tx via BDK with higher fee rate, same inputs
- Show fee delta to user before confirming

### Layer 3: Auto Anchor Bumping

- Implement `Event_BumpTransaction` handler (currently TODO)
- Use BDK UTXOs to fund CPFP for anchor outputs
- Fee rate from LDK's recommendation in the event
- Cap maximum auto-bump fee (safety guardrail)
- Log/notify user when auto-bump occurs

## Open Questions

None — all resolved.

## Resolved Questions

1. **Max rebroadcast duration** — Rebroadcast indefinitely. It's just a POST to Esplora, very cheap. If stuck, user can speed up via RBF (Layer 2). No benefit to silently stopping.
2. **RBF on LDK funding txs** — No, user sends only. Funding txs go through LDK's own broadcaster which already has retry logic. Keep funding tx construction as-is to avoid potential LDK issues with RBF-signaled inputs.
3. **Fee cap on manual RBF** — Same 50,000 sat cap as initial sends. Simple and consistent.
