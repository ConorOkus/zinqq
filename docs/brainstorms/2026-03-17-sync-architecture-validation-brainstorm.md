# Sync Architecture Validation: Zinqq vs LDK Node

**Date:** 2026-03-17
**Status:** Research complete
**Reference:** [LDK Node](https://github.com/lightningdevkit/ldk-node)

## What We're Studying

Compare Zinqq's onchain (BDK) and lightning (LDK) sync architecture against LDK Node's reference implementation to validate correctness and identify gaps.

## Architecture Comparison

### Sync Loop Structure

| Aspect                       | Zinqq                         | LDK Node                               |
| ---------------------------- | ----------------------------- | -------------------------------------- |
| Lightning sync interval      | 30s (`setTimeout`)            | 30s (`tokio::interval`)                |
| Onchain sync interval        | 30s (`setTimeout`)            | 80s (`tokio::interval`)                |
| Fee rate updates             | Part of BDK sync              | Separate 600s timer                    |
| RGS gossip sync              | ~10min (every 20 chain ticks) | 60min                                  |
| Peer tick / event processing | 10s `setInterval`             | `process_events_async` continuous loop |
| Chain backends               | Esplora only                  | Esplora, Electrum, Bitcoin Core RPC    |

### Lightning Chain Sync

**LDK Node:** Syncs ChannelManager + ChainMonitor + OutputSweeper in a single `tx_sync.sync(confirmables)` call. The `tx_sync` crate handles all Esplora queries, reorg detection, and confirmation tracking internally.

**Zinqq:** Manually implements the `Confirm` protocol in `chain-sync.ts`:

1. Check tip hash (skip if unchanged)
2. Reorg detection via `get_relevant_txids()`
3. `best_block_updated()` on all confirmables
4. Query Esplora per watched txid/output
5. `transactions_confirmed()` on matches
6. Prune confirmed items
7. Verify tip stability

This is more code to maintain but follows the same logical flow as `tx_sync` internally. **Correct implementation.**

### Onchain Wallet Sync

**LDK Node:** BDK `full_scan()` on first sync, then `get_incremental_sync_request()` on subsequent syncs. 80s interval.

**Zinqq:** `start_sync_with_revealed_spks()` → Esplora sync → `apply_update()` → persist changeset to IDB. 30s interval. **Correct implementation**, just more frequent than needed.

### Event Processing & Persistence

**LDK Node:** Single `process_events_async()` background loop handles events, persistence, peer management, and gossip.

**Zinqq:** Split across:

- 10s `setInterval` for peer ticks + event drain + balance computation
- Chain sync loop handles `timer_tick_occurred()`, `rebroadcast_pending_claims()`, persistence checks
- Periodic graph/scorer persistence every ~5 minutes
- Visibility-change flush on tab hide

**Both approaches are valid.** Zinqq's split gives finer control over timing in a browser environment.

### Error Handling

**LDK Node:** Silent error swallowing (`let _ = ...`), `MissedTickBehavior::Skip`, per-operation timeouts (90s onchain, 30s lightning).

**Zinqq:** Exponential backoff with jitter, stale detection after 3 consecutive errors, `Promise.allSettled` for partial failure resilience, 10s per-request timeout. **Better observability than LDK Node.**

### Concurrency

**LDK Node:** `WalletSyncStatus` with broadcast channels — concurrent sync requests subscribe to in-progress result.

**Zinqq:** BDK loop paused during tx building. `setTimeout` scheduling (next tick after completion) prevents self-overlap. No explicit dedup guard.

## What's Correct

- **Chain sync protocol implementation** — follows the `Confirm` trait contract correctly
- **Persistence strategy** — `needs_persistence` checks, periodic graph/scorer saves, visibility-change flush all mirror LDK Node
- **Backoff and error handling** — better than reference implementation
- **Pause/resume during tx building** — smart race condition prevention
- **Two separate confirmables** (ChannelManager + ChainMonitor) — correct for tx-based sync

## Gaps Identified

### 1. No Overall Sync Timeout (Priority: Medium)

**Risk:** If Esplora is slow and many txids/outputs are watched, `syncOnce()` could run for minutes since each request gets up to 10s.

**LDK Node approach:** Wraps lightning sync in 30s timeout, onchain in 90s.

**Recommendation:** Wrap `syncOnce()` in `Promise.race` with a 30-60s timeout. Log timeout as a distinct error type.

### 2. OutputSweeper Not Used as Confirmable (Priority: Medium)

**Risk:** Sweep transactions are broadcast reactively on `SpendableOutputs` events and at startup recovery. If a sweep tx gets reorged, stuck in mempool, or the browser closes between broadcast and confirmation, there's no mechanism to detect and re-sweep during the normal sync loop.

**Current flow:**

1. `SpendableOutputs` event → serialize descriptors → persist to IDB
2. Build + broadcast sweep tx via `KeysManager.as_OutputSpender()`
3. Delete IDB entries after successful broadcast
4. Startup recovery: re-sweep any persisted descriptors

**LDK Node flow:**

1. `SpendableOutputs` event → `OutputSweeper.track_spendable_outputs()`
2. OutputSweeper registered as third confirmable in sync loop
3. Automatically monitors sweep tx confirmations, re-broadcasts, handles reorgs

**What's available:** `OutputSweeper` and `TrackedSpendableOutput` are exported from `lightningdevkit` v0.1.8-0 WASM bindings.

**Why it wasn't adopted:** OutputSweeper requires implementing `KVStore`, `Listen`/`Confirm` traits, and additional lifecycle management — heavier than the current manual approach.

**Recommendation:** Current approach is acceptable for now. The main risk is sweep tx reorgs, which are rare on signet. If moving to mainnet, revisit adopting OutputSweeper or adding sweep tx confirmation tracking to the existing sync loop.

### 3. Onchain Sync Interval Too Frequent (Priority: Low)

**Current:** 30s. **LDK Node:** 80s. Onchain balance is not time-sensitive. Reducing to 60-80s would cut Esplora load in half for BDK sync.

### 4. RGS Interval Too Frequent (Priority: Low)

**Current:** ~10min. **LDK Node:** 60min. Network graph doesn't change fast enough on signet to warrant 10-minute updates. Consider 30-60 minutes.

## Key Decisions

- **Architecture is sound** — no fundamental correctness issues found
- **Manual Esplora sync is acceptable** — more code than `tx_sync` crate but equivalent logic
- **OutputSweeper deferred** — manual sweep with IDB persistence is sufficient for signet, revisit for mainnet
- **Three low-effort improvements identified** — sync timeout, relaxed intervals

## Open Questions

None — research is complete. Improvements above can be addressed individually when prioritized.
