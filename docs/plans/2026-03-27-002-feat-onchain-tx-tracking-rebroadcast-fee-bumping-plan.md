---
title: 'feat: On-Chain Transaction Tracking, Rebroadcast & Fee Bumping'
type: feat
status: active
date: 2026-03-27
origin: docs/brainstorms/2026-03-27-onchain-tx-tracking-rebroadcast-brainstorm.md
---

# feat: On-Chain Transaction Tracking, Rebroadcast & Fee Bumping

## Enhancement Summary

**Deepened on:** 2026-03-27
**Sections enhanced:** All phases + cross-cutting concerns
**Review agents used:** TypeScript reviewer, Security sentinel, Performance oracle, Race condition reviewer, Architecture strategist, Code simplicity reviewer, Data integrity guardian, Learnings researcher, Best practices researcher

### Key Improvements

1. **Prerequisite fixes identified** — `putChangeset` read-modify-write race and sync pause counter must be fixed before this feature
2. **Simplification** — Expose `tipHeight` on context instead of storing `confirmations` on each tx; single auto-selected bump rate instead of 3 presets; filter replaced txs rather than complex grouping
3. **Critical security** — UTXO lock must be persisted (not just in-memory); anchor reserve enforcement must ship with Layer 3; `replacedBy` must be set atomically before broadcast
4. **11 new institutional learnings** incorporated from `docs/solutions/`

### New Considerations Discovered

- `putChangeset` has an existing read-modify-write race condition (two concurrent callers can lose deltas)
- Sync loop pause is a boolean, not a counter — second concurrent pauser causes premature resume
- `CoinSelectionSource` change outputs must use `peek_address` (not `next_unused_address`) due to sync constraint
- Full-RBF is now default in Bitcoin Core v28+ — all unconfirmed txs are replaceable regardless of signaling
- BIP 125 Rule 3 (absolute fee, not just rate) is the most common RBF implementation mistake

---

## Overview

Add complete post-broadcast on-chain transaction management: track pending transactions, rebroadcast them until confirmed, allow users to manually RBF-bump stuck sends, and implement LDK's anchor channel fee bumping via `BumpTransactionEventHandler` + `CoinSelectionSource`.

Three independently shippable layers, each building on the previous (see brainstorm: `docs/brainstorms/2026-03-27-onchain-tx-tracking-rebroadcast-brainstorm.md`).

## Problem Statement

Today Zinqq has zero post-broadcast transaction management. If a user send doesn't propagate or gets stuck in the mempool, there's no recovery path. The `Event_BumpTransaction` handler for LDK anchor channels is stubbed out (`src/ldk/traits/event-handler.ts:376`), meaning force-close scenarios can't properly resolve — risking HTLC fund loss.

## Proposed Solution

**Layered rollout** — three phases that each deliver standalone value:

1. **Layer 1 — Rebroadcast + Tracking**: Persist raw tx hex, rebroadcast unconfirmed sends during BDK sync loop, add broadcast retry, expose tip height for confirmation count.
2. **Layer 2 — Manual "Speed Up" UI**: Transaction detail screen with "Speed up" button using BDK's `wallet.build_fee_bump(txid)`.
3. **Layer 3 — Auto Anchor Bumping**: Implement `CoinSelectionSource` backed by BDK, wire into LDK's `BumpTransactionEventHandler`.

**Key discovery from research**: BDK 2.x already enables RBF by default (`nSequence = 0xFFFFFFFD`). The `enable_rbf()` call is a documented no-op. No code change needed for RBF signaling. Full-RBF is also now the Bitcoin Core v28+ default, so all unconfirmed transactions are replaceable network-wide regardless of signaling.

## Technical Approach

### Architecture

```
┌─────────────────────────────────────────────────┐
│                   UI Layer                       │
│  Activity.tsx ← TxDetail.tsx (new) ← Speed Up   │
└─────────┬──────────────────────────────┬────────┘
          │                              │
┌─────────▼──────────┐    ┌─────────────▼─────────┐
│  OnchainContext     │    │  LDK Event Handler    │
│  buildSignBroadcast │    │  Event_BumpTransaction│
│  useFeeBump (hook)  │    │  → BumpTxEventHandler │
└─────────┬──────────┘    └──────────┬────────────┘
          │                          │
          │    ┌─────────────────────┤
          │    │  utxo-lock.ts (new) │
          │    └─────────────────────┤
          │                          │
┌─────────▼──────────────────────────▼────────────┐
│              BDK Wallet (WASM)                   │
│  build_tx() · build_fee_bump() · transactions() │
│  sign() · balance · take_staged()                │
└─────────┬───────────────────────────────────────┘
          │
┌─────────▼──────────────────────────────────────┐
│              IndexedDB                          │
│  bdk_changeset · pending_send_txs (new)        │
└────────────────────────────────────────────────┘
```

> **Simplification from review:** Dropped `anchor_claim_utxos` IDB store. LDK re-emits `BumpTransaction` events on restart — crash recovery is handled by LDK's event re-emission, not by persisting claim-to-UTXO mappings. UTXO lock module (`utxo-lock.ts`) is a dedicated module, not an anonymous shared Set.

### Prerequisite Fixes

These existing bugs must be fixed before implementing this feature:

- [ ] **Fix `putChangeset` read-modify-write race** — `src/onchain/storage/changeset.ts` performs read and write in separate IDB transactions. Two concurrent callers can lose deltas. Fix: use a single readwrite IDB transaction for the get-merge-put cycle, or serialize access with a promise queue. _(Source: Race condition reviewer, Data integrity guardian)_

- [ ] **Convert sync loop pause from boolean to counter** — `src/onchain/sync.ts` uses a bare `paused` boolean. When `buildFeeBump` is added alongside `buildSignBroadcast`, the first to resume will unpause the loop while the second is still in flight. Fix: use a pause counter (`pauseCount++` / `Math.max(0, pauseCount - 1)`). _(Source: Race condition reviewer)_

- [ ] **Await changeset persistence in `buildSignBroadcast`** — `src/onchain/context.tsx:189` fires `persistChangeset` as fire-and-forget after broadcast. If the tab closes immediately, the wallet won't know about the transaction on next startup. Fix: `await` the changeset persistence before returning the txid. _(Source: Race condition reviewer)_

### Implementation Phases

#### Phase 1: Rebroadcast + Tracking

**Goal:** All user sends are tracked and rebroadcast until confirmed. Broadcast failures are retried.

**Tasks:**

- [ ] **Add `pending_send_txs` IDB store** — Bump `DB_VERSION` to 9 in `src/storage/idb.ts`. Create a typed accessor module `src/onchain/storage/pending-sends.ts` (following the `changeset.ts` pattern — do not scatter raw `idbGet`/`idbPut` calls in business logic). Schema per entry:

  ```typescript
  interface PendingSendTx {
    readonly txid: string
    readonly rawHex: string
    readonly createdAt: number
    readonly feeRateSatVb: number // store at build time for Speed Up UI context
    readonly replacedBy: string | null
  }
  ```

  Key by txid.

  > **Research insight:** Add a `feeRateSatVb` field at build time so the Speed Up UI can show current fee rate without re-parsing raw tx hex. _(Source: Architecture strategist)_

- [ ] **Persist raw tx hex before broadcast** in `buildSignBroadcast` (`src/onchain/context.tsx:~186`). After `psbt.extract_tx()`, serialize to hex and write to `pending_send_txs` store _before_ calling `broadcastWithRetry`. This ensures crash recovery even if broadcast hangs.
  - If broadcast succeeds: entry stays (rebroadcast loop will clean up after confirmation).
  - If broadcast fails after retries: entry stays, rebroadcast loop will retry next tick.

  > **Research insight:** Add IDB write retry flag (local dirty flag pattern from `ldk-trait-defensive-hardening-patterns.md`). If the IDB write fails, the next sync tick retries. _(Source: Learnings researcher)_

- [ ] **Add broadcast retry to user sends** — Reuse `broadcastWithRetry` from `src/ldk/traits/broadcaster.ts`. Call it from `buildSignBroadcast` instead of bare `esplora.broadcast()`. 5 retries, exponential backoff (1s, 2s, 4s, 8s, 16s). Handle idempotent "already known" responses.

  > **Research insight:** Refactor `broadcastWithRetry` return type to a discriminated union before use:
  >
  > ```typescript
  > type BroadcastResult =
  >   | { status: 'broadcast'; txid: string }
  >   | { status: 'already-known' }
  >   | { status: 'in-flight' }
  > ```
  >
  > The current string return (`txid | 'in-flight' | 'already-broadcast'`) is stringly typed and error-prone. _(Source: TypeScript reviewer)_

- [ ] **Add rebroadcast as a separate async function called from BDK sync loop** — Extract into `src/onchain/rebroadcast.ts`. After sync completes (~line 71 of `sync.ts`), call `void rebroadcastPendingTxs(wallet, esploraUrl).catch(...)`. The function:
  1. Reads all entries from `pending_send_txs` via `idbGetAll` (single IDB read)
  2. Shares the `wallet.transactions()` result that was already fetched for the UI's `listTransactions()` — do NOT call `wallet.transactions()` a second time (avoids duplicate WASM boundary crossing)
  3. For each pending entry: if confirmed in wallet → delete from store. If unconfirmed and `replacedBy` is null → POST raw hex to Esplora (fire-and-forget)
  4. Use `idbDeleteBatch` for confirmed entries (single IDB write instead of N)

  > **Research insight:** Do NOT iterate `wallet.transactions()` independently for rebroadcast. Share the result to avoid O(n) WASM serialization cost every 80s. At 500+ transactions, double traversal costs 20-40ms on mobile. _(Source: Performance oracle)_

  > **Research insight:** When confirmation is detected during rebroadcast cleanup, immediately invoke the balance/transaction refresh callback rather than waiting for the next scheduled sync tick. Use `queueMicrotask` throttling if multiple txs confirm in the same tick. _(Source: Learnings from `channel-state-ui-update-10s-delay.md`)_

- [ ] **Expose `tipHeight` on `OnchainContext`** — After `esploraClient.sync()`, extract the current tip height via `wallet.latest_checkpoint()`. Surface it in the `OnchainContextValue` ready state.

  > **Research insight:** Do NOT add `confirmations: number` to the `OnchainTransaction` type. It is a derived value that goes stale between syncs. Instead, expose `tipHeight` on context and let the UI compute `tipHeight - confirmationBlockHeight + 1` at render time. _(Source: TypeScript reviewer)_

- [ ] **Add `confirmationBlockHeight` to `OnchainTransaction`** — Extract from BDK's `chain_position.confirmation_block_time.block_id.height` for confirmed txs, `null` for pending. The UI computes confirmation count from `tipHeight - confirmationBlockHeight + 1`.

- [ ] **Add catch-up sync on `visibilitychange`** — When `document.visibilityState` changes to `'visible'`, trigger an immediate BDK sync. Chrome throttles background tab timers to 1-minute resolution after 5 minutes; the 80s sync interval may drift. _(Source: Best practices researcher)_

**Files touched:**

- `src/storage/idb.ts` — new store, version bump
- `src/onchain/storage/pending-sends.ts` — new typed accessor module
- `src/onchain/storage/changeset.ts` — fix read-modify-write race (prerequisite)
- `src/onchain/context.tsx` — persist tx hex, use broadcastWithRetry, await changeset persist
- `src/onchain/sync.ts` — call rebroadcast function, tip height extraction, pause counter (prerequisite)
- `src/onchain/rebroadcast.ts` — new module for rebroadcast logic
- `src/onchain/onchain-context.ts` — add tipHeight, confirmationBlockHeight on tx type
- `src/hooks/use-transaction-history.ts` — pass through confirmationBlockHeight
- `src/ldk/traits/broadcaster.ts` — refactor return type to discriminated union

**Success criteria:**

- [ ] User sends are persisted to IDB before broadcast
- [ ] Failed broadcasts are retried 5 times with exponential backoff
- [ ] Unconfirmed sends are rebroadcast every sync tick (80s)
- [ ] Confirmed sends are cleaned up from the pending store
- [ ] `tipHeight` is exposed on context; UI can compute confirmation count
- [ ] App restart recovers pending sends and continues rebroadcasting
- [ ] Tab foreground triggers catch-up sync

---

#### Phase 2: Manual "Speed Up" UI

**Goal:** Users can tap a pending transaction, see its status, and fee-bump it via RBF.

**Tasks:**

- [ ] **Create transaction detail screen** — New route `/tx/:txid` with component `src/pages/TxDetail.tsx`. Model the speed-up sub-flow as a discriminated union state machine (following the pattern from `react-send-flow-amount-first-state-machine.md`):

  ```typescript
  type TxDetailStep = 'detail' | 'confirming-bump' | 'bumping' | 'bump-success' | 'bump-error'
  ```

  Shows:
  - Direction (sent/received) and amount
  - Txid (truncated, copyable)
  - Confirmation count (computed: `tipHeight - confirmationBlockHeight + 1`) and pending age (from `firstSeen` or `createdAt`)
  - Fee paid and fee rate (sat/vB)
  - Block explorer link (`${ONCHAIN_CONFIG.explorerUrl}/tx/${txid}`)
  - "Speed up" button (only for pending sends where `sent > 0`)

- [ ] **Make Activity list items tappable** — In `src/pages/Activity.tsx`, navigate to `/tx/:txid` on tap.

- [ ] **Implement fee bump as a dedicated `useFeeBump` hook** — New hook `src/hooks/use-fee-bump.ts` that internally uses `useOnchain()`. Do NOT expand `OnchainContext` with `buildFeeBump` — keep the context focused on wallet fundamentals (balance, send, receive). The hook:
  1. Acquires a `bumpingRef` guard to prevent double-tap races (pattern from `react-send-flow-amount-first-state-machine.md`)
  2. Pauses sync loop (same pattern as `buildSignBroadcast`)
  3. Calls `wallet.build_fee_bump(txid)` — verify WASM binding accepts string txid or requires `Txid.from_string()`
  4. Chains `.fee_rate(newFeeRate).finish()` to get new PSBT
  5. Fee sanity check: `psbt.fee() <= MAX_FEE_SATS` (50,000 sats). Also validate BIP 125 Rule 3: `newFee >= originalFee + (replacementVsize * minRelayFeeRate)`
  6. Signs with `wallet.sign(psbt, new SignOptions())`
  7. Extracts tx, computes new txid
  8. **Atomically** updates `pending_send_txs` in a single IDB transaction: set `replacedBy` on original AND insert new entry. Must happen BEFORE broadcast (not after) to prevent rebroadcast loop from picking up the stale original.
  9. Broadcasts via `broadcastWithRetry`
  10. Awaits changeset persistence (including address reveal from change output)
  11. Resumes sync loop in finally block
  12. Accepts or creates an `AbortSignal` for cancellation on component unmount

  > **Research insight:** The `replacedBy` write MUST happen before broadcast. If broadcast succeeds but the IDB write fails, the rebroadcast loop will broadcast the original, racing with the replacement. Use a single IDB transaction for the update + insert. _(Source: Security sentinel, Data integrity guardian)_

  > **Research insight:** `build_fee_bump` can fail for: tx already confirmed, tx not in wallet, insufficient funds, fee rate not higher than original. Define explicit error types:
  >
  > ```typescript
  > type FeeBumpError =
  >   | { type: 'already-confirmed' }
  >   | { type: 'insufficient-funds' }
  >   | { type: 'fee-too-low'; minimumRate: number }
  >   | { type: 'tx-not-found' }
  >   | { type: 'unknown'; message: string }
  > ```
  >
  > _(Source: TypeScript reviewer)_

- [ ] **Speed-up confirmation screen** — Single "Speed up" action with auto-selected rate (2x current fee rate, or current mempool 1-block target, whichever is higher). Show:
  - Current fee rate vs. new fee rate
  - Fee delta: "Additional fee: +X sats"
  - Estimated confirmation time at new rate
  - Confirm button

  > **Simplification from review:** Skip the 3-preset fee picker. On signet, fee rates are nearly constant. A single auto-calculated rate with one-tap confirmation is simpler and covers the use case. Add manual rate selection later if needed. _(Source: Code simplicity reviewer, Best practices researcher — "Trezor Suite auto-calculates; BlueWallet presents single recommended rate")_

  > **Research insight:** Guard against negative bigint in fee delta display. If a subtraction underflow produces a negative value and it's used in formatting, it will silently produce wrong output. Clamp to zero minimum. _(Source: Learnings from `abort-controller-and-bigint-sign-fixes.md`)_

- [ ] **Handle RBF replacement in transaction history** — Filter replaced transactions out of the list entirely (where `replacedBy !== null` in `pending_send_txs`). Do NOT add complex "logical send" grouping by shared input set — it risks O(n²) comparisons and is over-engineered for the initial implementation. When a replacement confirms, BDK marks the original as conflicted — filter conflicted txs from the list.

  > **Simplification from review:** Filtering is simpler than grouping and less invasive to the `UnifiedTransaction` type contract. _(Source: TypeScript reviewer, Code simplicity reviewer, Performance oracle — "O(n) grouping via hash map if ever needed, but filtering is sufficient initially")_

- [ ] **Error handling** — Map `build_fee_bump` WASM errors to `FeeBumpError` discriminated union. Surface user-friendly messages. Also handle Esplora rejection messages specific to RBF: `insufficient fee`, `too-long-mempool-chain`, `txn-mempool-conflict`. _(Source: Best practices researcher)_

**Files touched:**

- `src/pages/TxDetail.tsx` — new file
- `src/pages/Activity.tsx` — make items tappable
- `src/routes/router.tsx` — add `/tx/:txid` route
- `src/hooks/use-fee-bump.ts` — new hook (NOT on OnchainContext)
- `src/hooks/use-transaction-history.ts` — filter replaced txs
- `src/onchain/storage/pending-sends.ts` — atomic replace helper

**Success criteria:**

- [ ] Tapping a transaction in Activity opens the detail screen
- [ ] Pending sends show a "Speed up" button
- [ ] Speed-up auto-selects a rate and shows fee delta
- [ ] Fee bump builds a valid RBF replacement via `wallet.build_fee_bump()`
- [ ] `replacedBy` and new entry written atomically to IDB BEFORE broadcast
- [ ] Replaced txs are filtered from Activity list
- [ ] All `build_fee_bump` error cases show user-friendly messages
- [ ] Double-tap guard prevents concurrent bump attempts

---

#### Phase 3: Auto Anchor Bumping

**Goal:** LDK's `Event_BumpTransaction` is fully handled. Anchor channel force-closes can resolve safely.

**Tasks:**

- [ ] **Implement `CoinSelectionSource` backed by BDK** — New file `src/ldk/traits/coin-selection-source.ts`. Two methods:

  `select_confirmed_utxos(claim_id, must_spend, must_pay_to, target_feerate_sat_per_1000_weight)`:
  - **Validate and cap incoming feerate** — Apply `MAX_FEE_SAT_KW` cap (matching the existing fee estimator pattern at `fee-estimator.ts:5`) to guard against corrupted/extreme feerate values from LDK internals. _(Source: Learnings from `ldk-trait-defensive-hardening-patterns.md`)_
  - Query BDK wallet for confirmed UTXOs (synchronous in WASM memory)
  - Exclude UTXOs locked by other active claims (via `utxo-lock.ts` module)
  - Select enough UTXOs to meet the target feerate
  - Track selected UTXOs against `claim_id` for re-bump reuse
  - **Use `peek_address` (NOT `next_unused_address`) for change output scripts** — `next_unused_address` triggers an address reveal that requires async persistence. `peek_address` with deterministic index + deferred `reveal_addresses_to` is correct for synchronous contexts. _(Source: Learnings from `bdk-ldk-force-close-destination-script-interop.md`)_
  - Return `CoinSelection` with selected UTXOs and change output

  `sign_psbt(psbt)`:
  - Deserialize PSBT, sign with `wallet.sign()` using `trust_witness_utxo = true`
  - Return signed transaction bytes
  - **Immediately queue changeset persistence via `queueMicrotask`** — Do not defer to next sync tick. The deferred window is too long (~30s) and risks losing change address reveals on crash. _(Source: Security sentinel)_

  **Critical constraint:** Both methods must be synchronous (WASM trait boundary). BDK wallet operations (balance, list UTXOs, sign) are synchronous in WASM. Changeset persistence is deferred via microtask.

  > **Research insight:** Explicitly verify every BDK method called within `CoinSelectionSource` is synchronous. TypeScript will NOT catch a `Promise` returned where a value is expected — it will silently produce `[object Promise]`. List: `wallet.list_unspent()`, `wallet.sign()`, `wallet.take_staged()`, `peek_address()`. _(Source: TypeScript reviewer)_

  > **Research insight:** Assert BDK wallet is initialized before `CoinSelectionSource` construction — fail loudly if null. Init ordering is load-bearing (BDK must be ready before LDK deserialization). _(Source: Learnings from `bdk-ldk-force-close-destination-script-interop.md`)_

- [ ] **Create UTXO lock module** — New file `src/onchain/utxo-lock.ts`. Dedicated module with typed API:

  ```typescript
  type OutpointKey = `${string}:${number}`
  function toOutpointKey(txid: string, vout: number): OutpointKey
  function lock(key: OutpointKey): void
  function unlock(key: OutpointKey): void
  function isLocked(key: OutpointKey): boolean
  function getLockedOutpoints(): ReadonlySet<OutpointKey>
  ```

  - Both `CoinSelectionSource` and `useFeeBump` import from this module — explicit, testable dependency
  - Lock acquisition in `useFeeBump` must happen **synchronously before the first `await`** — `CoinSelectionSource` is synchronous at the WASM boundary, so a `BumpTransaction` event could fire during any `await` gap in `useFeeBump`
  - **Known limitation for signet:** Locks are in-memory and lost on page refresh. On crash, LDK re-emits `BumpTransaction` and fresh UTXOs are selected. Document for mainnet readiness.

  > **Research insight:** Use the branded `OutpointKey` type to prevent format drift between callers. Without it, one caller might use `txid:vout` while another uses `txid-vout`, and the Set would fail to deduplicate. _(Source: TypeScript reviewer)_

- [ ] **Wire `BumpTransactionEventHandler`** — In `src/ldk/traits/event-handler.ts`, replace the TODO stub at line 376:
  1. Import `BumpTransactionEventHandler` from LDK
  2. Instantiate with: existing `broadcaster`, new `CoinSelectionSource`, existing `signerProvider`, existing `logger`
  3. **Wrap in try/catch** — An uncaught error in `handle_event` aborts the entire `process_pending_events` batch, losing remaining events. _(Source: Learnings from `ldk-event-handler-patterns.md`)_
  4. **Flush ChannelManager persistence immediately after anchor bump** — Don't wait for 30s sync tick. _(Source: Learnings from `ldk-event-handler-patterns.md`)_

- [ ] **Anchor reserve warning** — When on-chain balance is zero and Lightning channels exist, log `[Fund Safety]` warning. In the UI, show a warning banner on the home screen. On `sendMax`: subtract a minimum reserve (~10,000 sats) from the drain amount when `channelManager.list_channels().length > 0`. This MUST ship with Layer 3.

  > **Security insight (CRITICAL):** The original plan deferred anchor reserve to "Future Considerations." This is too late — `sendMax` followed by a counterparty force close means HTLCs cannot be resolved. On signet the funds are free, but the pattern must be correct for mainnet carry-forward. _(Source: Security sentinel)_

- [ ] **Separate fee policy for anchor bumps** — Respect LDK's target feerate from the event (already validated/capped in `select_confirmed_utxos`). Log all auto-bumps with `[Anchor Bump]` prefix including cost breakdown.

  > **Simplification from review:** Drop the explicit 500,000 sat cap and the "lesser of HTLC value" calculation for signet. The feerate cap in `select_confirmed_utxos` provides sufficient protection. Revisit cap design for mainnet with a percentage-based approach (e.g., 10% of HTLC exposure). _(Source: Code simplicity reviewer, Security sentinel)_

- [ ] **Claim cleanup lifecycle** — Release UTXO locks when:
  - The claim tx confirms (detected during LDK chain sync)
  - The claim resolves via a different path (counterparty broadcasts)
  - Do NOT use a fixed 144-block timeout — it's unsafe (HTLCs can have longer timeouts). Only clean up on confirmed resolution. _(Source: Security sentinel)_

**Files touched:**

- `src/ldk/traits/coin-selection-source.ts` — new file
- `src/onchain/utxo-lock.ts` — new file
- `src/ldk/traits/event-handler.ts` — replace BumpTransaction stub, add try/catch + CM flush
- `src/onchain/context.tsx` — anchor reserve in sendMax
- `src/hooks/use-fee-bump.ts` — UTXO lock filtering

**Success criteria:**

- [ ] `Event_BumpTransaction` is handled (no more console.warn stub)
- [ ] `CoinSelectionSource` selects confirmed BDK UTXOs synchronously
- [ ] Incoming feerate is validated and capped
- [ ] Change outputs use `peek_address` with deferred `reveal_addresses_to`
- [ ] Anchor bump txs are broadcast via existing `broadcastWithRetry`
- [ ] Re-bumps (same `claim_id`, higher feerate) reuse previously assigned UTXOs
- [ ] UTXO locks prevent conflicts between manual bumps and anchor bumps
- [ ] `sendMax` reserves minimum sats when channels are open
- [ ] try/catch protects event batch from anchor bump failures
- [ ] CM persistence flushes immediately after anchor events

## System-Wide Impact

### Interaction Graph

User send → `buildSignBroadcast` → persist tx hex to IDB → `broadcastWithRetry` → Esplora POST → BDK sync loop detects confirmation → clean up IDB entry → immediate UI refresh callback.

Fee bump → `useFeeBump` hook → acquire bump guard → pause sync → `wallet.build_fee_bump()` → new PSBT → validate BIP 125 Rule 3 (absolute fee) → sign → atomically mark original as replaced + insert new entry in IDB → `broadcastWithRetry` → await changeset persist → resume sync.

LDK force close → `Event_BumpTransaction` → try/catch → `BumpTransactionEventHandler.handle_event()` → `CoinSelectionSource.select_confirmed_utxos()` (cap feerate, read BDK UTXOs, lock via `utxo-lock.ts`, use `peek_address` for change) → `CoinSelectionSource.sign_psbt()` (sign with BDK, queue changeset persist via microtask) → broadcaster POSTs to Esplora → flush CM persistence → LDK chain sync detects confirmation → release UTXO locks.

### Error Propagation

- **Broadcast failures** in `broadcastWithRetry`: 5 retries with exponential backoff, then throw. For user sends: error surfaces to UI. For rebroadcast loop: caught and logged, retried next tick. For anchor bumps: caught by try/catch wrapper, LDK will re-emit the event with higher feerate.
- **`build_fee_bump` failures**: synchronous throw from BDK WASM. Caught in `useFeeBump`, mapped to `FeeBumpError` discriminated union, surfaced as user-friendly error in TxDetail UI.
- **`CoinSelectionSource` failures**: if no UTXOs available, LDK cannot bump. Console warning `[Fund Safety]` logged. Funds at risk if HTLCs time out — mitigated by anchor reserve warning in UI.
- **IDB write failures**: Retry via local dirty flag on next sync tick. Log `[Fund Safety]` if pending-send persistence fails.

### State Lifecycle Risks

- **Crash between tx hex persist and broadcast**: On restart, rebroadcast loop picks up the entry and broadcasts. Safe — the tx is valid and signed.
- **Crash between broadcast and changeset persist**: BDK wallet state on disk is stale. On restart, sync will reconcile with chain state. The tx is already broadcast, so no fund loss. _(Now mitigated by awaiting changeset persist in prerequisite fix.)_
- **Crash after CoinSelectionSource selects UTXOs**: UTXO locks lost (in-memory). LDK re-emits `BumpTransaction` event, fresh UTXOs selected. Previous bump tx still in mempool, so re-emission builds RBF replacement. _(Acceptable for signet; document for mainnet.)_
- **RBF replacement stored but original already confirmed**: Replacement broadcast returns "conflict" error. Rebroadcast loop detects original as confirmed and cleans up. No fund loss.
- **Stale `replacedBy` pointer (replacement never broadcast)**: Rebroadcast loop validates that `replacedBy` target exists in the store before skipping the original. If target missing, clear the pointer and rebroadcast the original.

### API Surface Parity

- `OnchainTransaction` type gains `confirmationBlockHeight: number | null` — consumers compute confirmation count from `tipHeight`
- `OnchainContextValue` ready state gains `tipHeight: number`
- New `useFeeBump` hook — page-level concern, not on context
- New `utxo-lock.ts` module — shared between `useFeeBump` and `CoinSelectionSource`
- IDB version bump from 8 to 9 — automatic migration on first open (single bump for all new stores)

## Acceptance Criteria

### Functional Requirements

- [ ] All user on-chain sends are persisted as raw hex before broadcast
- [ ] Failed broadcasts are retried 5 times with exponential backoff
- [ ] Unconfirmed sends are rebroadcast every BDK sync tick (80s) until confirmed
- [ ] Tip height exposed on context; UI computes confirmation count at render time
- [ ] Users can tap pending sends and fee-bump via RBF with one-tap Speed Up
- [ ] Fee bump uses BDK's `build_fee_bump(txid)` API with BIP 125 Rule 3 validation
- [ ] Replaced txs filtered from Activity list
- [ ] `Event_BumpTransaction` handles both `ChannelClose` and `HTLCResolution`
- [ ] Anchor bumps use confirmed BDK UTXOs via `CoinSelectionSource` with feerate cap
- [ ] UTXO locks prevent conflicts between manual bumps and anchor bumps
- [ ] `sendMax` reserves minimum sats when Lightning channels are open

### Non-Functional Requirements

- [ ] No new external dependencies (all APIs available in BDK/LDK WASM)
- [ ] Rebroadcast loop shares `wallet.transactions()` result with UI — no duplicate WASM crossing
- [ ] IDB schema migration is backward-compatible (new stores only, single version bump)
- [ ] All fund-critical operations log with `[Fund Safety]` prefix
- [ ] `putChangeset` race condition fixed (prerequisite)
- [ ] Sync loop pause counter prevents premature resume (prerequisite)

### Quality Gates

- [ ] Each layer has a separate PR for isolated review
- [ ] Manual testing on mutinynet for each layer before merge
- [ ] Test RBF replacement flow end-to-end (send → wait → bump → confirm)
- [ ] Test anchor bump with a simulated force close on mutinynet
- [ ] Verify `CoinSelectionSource` methods are synchronous — check no Promises leak through WASM boundary
- [ ] Test tab backgrounding → foreground catch-up sync

## Dependencies & Prerequisites

- BDK WASM v0.3.0 — already in use, `build_fee_bump` available but unused
- LDK WASM v0.1.8-0 — already in use, `BumpTransactionEventHandler` and `CoinSelectionSource` available
- No new npm dependencies required
- **Prerequisites must be merged first:** `putChangeset` race fix, sync pause counter, changeset await

## Risk Analysis & Mitigation

| Risk                                                    | Impact                                    | Likelihood | Mitigation                                                                                       |
| ------------------------------------------------------- | ----------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `CoinSelectionSource` sync constraint fails in practice | Layer 3 blocked                           | Medium     | Prototype in isolation first. Verify every BDK method is sync in WASM.                           |
| User sends all funds, no UTXOs for anchor bumps         | HTLC fund loss on force close             | Medium     | Anchor reserve enforcement in `sendMax` (ships with Layer 3). UI warning.                        |
| `build_fee_bump` WASM parameter type mismatch           | Layer 2 delayed                           | Low        | Verify string vs `Txid` object in WASM bindings before implementation.                           |
| Race between rebroadcast and fee bump                   | Stale original rebroadcast                | Low        | Atomic `replacedBy` + new entry IDB write before broadcast. Rebroadcast validates target exists. |
| `putChangeset` race condition (existing)                | Lost changeset deltas, stale wallet state | Medium     | Fix as prerequisite before this feature.                                                         |
| Background tab timer throttling                         | Delayed rebroadcast/sync                  | Low        | Catch-up sync on `visibilitychange`.                                                             |
| BIP 125 Rule 3 violation (absolute fee)                 | Replacement rejected by mempool           | Medium     | Validate `newFee >= originalFee + replacementVsize * minRelayFeeRate`.                           |

## Future Considerations

- **Anchor reserve enforcement mainnet hardening**: Enforce configurable per-channel reserve (following ldk-node's `AnchorChannelsConfig.per_channel_reserve_sats`). Block sends that would breach reserve.
- **Multi-server broadcast**: For mainnet, broadcast to multiple independent Esplora instances. Single endpoint is a censorship/availability SPOF. _(Source: Security sentinel)_
- **Auto-RBF for user sends**: If unconfirmed >10 minutes and fee market has risen, prompt the user to bump.
- **Manual fee rate input**: Add advanced toggle for manual rate entry alongside auto-calculated rate.
- **IDB encryption**: Encrypt IDB values with a key derived from wallet passphrase. Raw tx hex reveals UTXOs, amounts, and change addresses. _(Source: Security sentinel)_
- **`CoinSelectionSource` UTXO lock persistence**: For mainnet, persist UTXO locks to IDB to survive crashes during anchor bumps.

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-27-onchain-tx-tracking-rebroadcast-brainstorm.md](../brainstorms/2026-03-27-onchain-tx-tracking-rebroadcast-brainstorm.md) — Key decisions carried forward: RBF for user sends (not funding txs), manual speed-up + auto anchor bumps, rebroadcast via BDK sync loop indefinitely, 50k sat fee cap for user bumps.

### Internal References

- BDK TxBuilder API (including `build_fee_bump`): `node_modules/@bitcoindevkit/bdk-wallet-web/bitcoindevkit.d.ts:873-1167`
- `buildSignBroadcast` helper: `src/onchain/context.tsx:166-215`
- LDK broadcaster with retry: `src/ldk/traits/broadcaster.ts:9-54`
- BDK sync loop: `src/onchain/sync.ts:42-85`
- Event_BumpTransaction stub: `src/ldk/traits/event-handler.ts:376-379`
- IndexedDB storage: `src/storage/idb.ts`
- OnchainTransaction type: `src/onchain/onchain-context.ts:15-22`
- Activity page: `src/pages/Activity.tsx`
- Send flow: `src/pages/Send.tsx`
- LDK chain sync (tip height): `src/ldk/sync/chain-sync.ts:48`
- BDK changeset persistence: `src/onchain/storage/changeset.ts`
- Fee estimator (feerate cap pattern): `src/ldk/traits/fee-estimator.ts:5`

### Institutional Learnings Applied

- **Persist changeset AFTER broadcast** (from `bdk-wasm-onchain-send-patterns.md`)
- **TxBuilder methods consume self — always chain calls** (from `bdk-wasm-txbuilder-consumes-self.md`)
- **Background persist race conditions** (from `vss-restore-background-persist-race.md`) — pause sync loop during wallet mutations
- **IDB cannot store bigint** (from `bdk-ldk-transaction-history-indexeddb-persistence.md`) — serialize amounts as strings
- **Address reveals must be persisted** (from `bdk-address-reveal-not-persisted.md`) — persist changeset after generating change addresses
- **Cap incoming feerate in trait implementations** (from `ldk-trait-defensive-hardening-patterns.md`) — apply MAX_FEE_SAT_KW in CoinSelectionSource
- **IDB write retry flags** (from `ldk-trait-defensive-hardening-patterns.md`) — local dirty flag for failed IDB writes
- **try/catch around event handlers** (from `ldk-event-handler-patterns.md`) — protect event batch from anchor bump failures
- **Flush CM persistence after fund-critical events** (from `ldk-event-handler-patterns.md`)
- **Discriminated union state machine for multi-step UI flows** (from `react-send-flow-amount-first-state-machine.md`)
- **Immediate UI refresh on state change** (from `channel-state-ui-update-10s-delay.md`) — callback on confirmation detection
- **Guard against negative bigint** (from `abort-controller-and-bigint-sign-fixes.md`) — clamp fee delta display
- **Use peek_address for synchronous change output generation** (from `bdk-ldk-force-close-destination-script-interop.md`)
- **Assert BDK wallet init ordering** (from `bdk-ldk-force-close-destination-script-interop.md`)

### External References

- BDK `build_fee_bump` docs: https://docs.rs/bdk_wallet/latest/bdk_wallet/struct.Wallet.html#method.build_fee_bump
- LDK Anchor Outputs: https://lightningdevkit.org/blog/anchor-outputs-channels-are-here/
- BIP 125 (RBF): https://github.com/bitcoin/bips/blob/master/bip-0125.mediawiki
- LDK `BumpTransactionEventHandler`: https://docs.rs/lightning/latest/lightning/events/bump_transaction/struct.BumpTransactionEventHandler.html
- Bitcoin Core v28.0 Full RBF Default: https://www.nobsbitcoin.com/bitcoin-core-v28/
- Bitcoin Core Mempool Replacement Policy: https://github.com/bitcoin/bitcoin/blob/master/doc/policy/mempool-replacements.md
- Chrome Timer Throttling: https://developer.chrome.com/blog/timer-throttling-in-chrome-88
- Page Visibility API: https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
