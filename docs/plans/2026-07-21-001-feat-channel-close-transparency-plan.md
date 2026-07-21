---
title: 'feat: Channel close transparency (coop + force close)'
type: feat
status: active
date: 2026-07-21
origin: docs/brainstorms/2026-07-21-channel-close-transparency-brainstorm.md
---

# ✨ feat: Channel Close Transparency (Coop + Force Close)

## Enhancement Summary

**Deepened on:** 2026-07-21 — 9 parallel review/research agents (architecture, simplicity, TypeScript, security, performance, data-integrity, frontend-races, agent-native, wallet-UX research).

### Key improvements over the first draft

1. **Facts-only records, derived status** — the stored 6-stage state machine is gone. Records store immutable facts (txids, heights, amounts); display status is a pure function. Kills stage-regression rules, dual sources of truth, and most idempotency risk.
2. **Singleton VSS key, IDB-first** — the draft's key-per-record design could never restore cross-device (VSS keys are HMAC-obfuscated; no prefix scan exists), and its "VSS-first" ordering contradicted the recovery pattern it cited. Now: one `close_records` map key, IDB-first, field-wise union merge on conflict.
3. **No broadcaster shim** — parsing every broadcast on the fund-critical hot path was triply redundant (BumpTransaction event + funding-outspend poll + sweep return cover all txid discovery) and a batch-abort hazard.
4. **Completion requires positive evidence** — absence from `get_claimable_balances()` is not proof of resolution; the draft could permanently mark unresolved closes "complete". Now: LDK monitor full-resolution status or funds confirmed in our own BDK wallet, with a ground-truth reopen escape hatch.
5. **Corrected LDK API usage** — `ChainMonitor.get_claimable_balances()` returns a flat list with no channel attribution; per-record data must use `list_monitors()` → `get_monitor(channelId)` → `monitor.get_claimable_balances()`.
6. **Write-once heights, never confirmation counts** — persisting `confirmations` meant a VSS round-trip per record per block for up to 14 days.
7. **Serialized writes** — three async writers per record (event handler, reconciliation, sweep attribution) now go through one per-record serialized mutator with a defined merge table.
8. **Full agent-native surface** — `window.__closeRecords` gains `estimate`/`close`/`forceClose`, with estimate logic in a pure function shared by screen and accessor.
9. **Copy grounded in the field** — Phoenix/Zeus/Bitkit/Mutiny/Breez patterns adopted; three Zinqq differentiators identified that no surveyed wallet ships.

## Overview

Make both cooperative and force-close flows legible end-to-end: a confirm screen that shows real costs and timelines before the user commits, a persistent per-close record that tracks every on-chain transaction through to completion, and a grouped "Channel close" item in transaction history with txids, mempool.space links, fees, and confirmations.

Today `CloseChannel.tsx` confirms a close with no fee estimate, the success screen shows no txid or explorer link, and once the channel disappears there is no record of what happened — the only surviving surface is the recovery banner when a sweep gets stuck (see brainstorm: docs/brainstorms/2026-07-21-channel-close-transparency-brainstorm.md).

## Problem Statement / Motivation

- Users initiate a close with no idea what it costs, how long it takes, or what comes back.
- A force close spans up to ~14 days and several transactions (commitment → optional anchor CPFP → sweep), all invisible in the app. The sweep even appears later as a bare, unexplained "Received" in history. (Mutiny shipped exactly this gap; its issues #1275/#1289 — "Funds stucked since force closure" — show the support burden.)
- Closes initiated by the counterparty (LSP force close, HTLC timeout) happen entirely silently.
- Approach B (derive from on-chain data, in-memory tagging) was rejected in the brainstorm because force closes span days and restarts are the norm; approach C (screen polish only) delivers no tracking. Persistent close records (approach A) are the only option whose grouping survives restarts and cross-device restore.

## Proposed Solution

Three pillars (all decided in the brainstorm):

1. **Pre-close clarity** — the confirm screen in `src/pages/CloseChannel.tsx` shows estimated cost (labeled rough estimate), expected timeline, amount expected back, and inline coop-vs-force education. Warn when the channel is non-anchor (no CPFP path — todos/359).
2. **Persistent close records** — a per-close record created at `Event_ChannelClosed`, updated as transactions are discovered and confirm. Persisted IDB + VSS. No backfill of pre-feature closes.
3. **Grouped history item** — close records become a third source in `src/hooks/use-transaction-history.ts`; one "Channel close" entry per record with a status badge, expandable to per-tx detail. The close's underlying on-chain txs are absorbed into the group, not double-listed. Blocked sweeps link into the existing `/recover` flow.

## Technical Approach

### Close record model: store facts, derive status

New module `src/ldk/close-records/` (mirroring `src/ldk/recovery/`). Records hold only **facts** — no stored stage. Event handlers become "append fact if absent": inherently idempotent, order-insensitive, regression-proof. Duplicate or late events are no-ops on stored facts.

Domain types use `bigint`; serialization to string happens only at the storage boundary (mirroring `PersistedPayment`/`SerializedPayment` in `src/ldk/storage/payment-history.ts`). The hard constraint is VSS, not IDB: IDB structured clone handles bigint natively, but the VSS path is `JSON.stringify`, which **throws** on bigint — one missed conversion persists locally, renders fine, and permanently fails every VSS write for that key. Unit test: `JSON.stringify(serialize(buildRecord(realEventFixture)))` succeeds and round-trips.

```typescript
// src/ldk/close-records/close-record.ts (domain shape; Serialized* twins at the storage boundary)
type Outpoint = { txid: string; vout: number }

type CloseTxRole = 'closing' | 'commitment' | 'anchor_cpfp' | 'htlc_claim' | 'sweep'

type CloseRecordTx = {
  txid: string
  role: CloseTxRole
  feeSats?: bigint
  confirmedAtHeight?: number // write-once at first confirmation; confirmations derived at render
}

type CloseRecord = {
  schemaVersion: 1 // records live indefinitely and sync across app versions; decode tolerantly, preserve unknown fields
  channelId: string
  fundingTxo?: Outpoint // primary key for closing-tx discovery
  closeType: 'coop' | 'force' | 'unknown'
  initiator: 'local' | 'remote' | 'unknown'
  closureReason?: string // raw ClosureReason variant name, display-only pass-through
  txs: CloseRecordTx[] // union by txid; one batched sweep txid may appear in N records
  expectedAmountSats?: bigint // estimate until complete; measured from BDK wallet outputs at completion
  claimableAtHeight?: number // from Balance_ClaimableAwaitingConfirmations.confirmation_height
  createdAt: number // stable history sort key; set at event time
  completedAt?: number // set-once, only on positive evidence (see Reconciliation)
}
```

Cut from the draft (all derivable): `stage`, `confirmations`, `balanceSource`, `counterpartyNodeId`, `sharedWithOtherCloses` (a sweep is shared iff its txid appears in >1 record — detect at render; a stored flag goes stale between the two records' writes).

**Derived display status** (pure function over a record + live inputs already in context — current height, pending descriptors, RecoveryState):

| Condition (first match wins)                                    | Badge                      |
| --------------------------------------------------------------- | -------------------------- |
| `completedAt` set                                               | Complete                   |
| RecoveryState says CPFP blocked for this channel (read-through) | Needs deposit → `/recover` |
| Sweep tx present, not yet confirmed                             | Returning to wallet        |
| `claimableAtHeight` in the future                               | Waiting (timelock)         |
| otherwise                                                       | Closing                    |

Badge names mirror ldk-node's sweep lifecycle (`ClaimableAwaitingConfirmations` → `BroadcastAwaitingConfirmation` → `AwaitingThresholdConfirmations`) — external validation the granularity is right. "Needs deposit" stays derived from `RecoveryState` (single writer, never stored on the record).

### Single creation point + safety net (no provisional records)

Records are created in exactly one place: `Event_ChannelClosed` (`src/ldk/traits/event-handler.ts:359-393`). The draft's provisional confirm-time record created a two-writer race (the event fires synchronously after `force_close_broadcasting_latest_txn`, and can win against the provisional persist, which then clobbers it) plus phantom-record cleanup paths for failed/stalled closes.

- **Coop-stall visibility** (LSP offline, tab closed — LDK never auto-falls-back to force close): shown from **live channel data**, not a record — a channel whose `ChannelDetails.get_channel_shutdown_state()` is not `NotShuttingDown` gets a "closing…" badge in the peers list with a "Force close instead" affordance. Confirm-screen copy: "keep the app open until the close completes."
- **Crash safety net**: while channels are open, persist a `channelId → fundingTxo` map (updated on channel open/sync). Reconciliation diffs this map against `list_channels()` and **creates** records for channels that vanished recordless — covering counterparty force closes where the tab died between `ok()` and the async persist. Without this, reconciliation only heals records that exist; this makes it heal missing ones too.

### Data sources (LDK 0.2.4-0, verified against installed bindings)

| Signal              | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Record creation     | `Event_ChannelClosed`: `reason`, `channel_funding_txo` (Option — handle None; degraded no-txid-discovery path), `channel_capacity_sats`, `last_local_balance_msat`. Do **not** fall back to channel capacity when local balance is unavailable (the existing `event-handler.ts:369-371` fallback overstates by the whole capacity — render "amount unavailable").                                                                                                                                                             |
| Closing txid        | **Not on any event, and no broadcaster shim.** (a) Anchor channels — the common Megalith/JIT case: `BumpTransactionEvent_ChannelClose.commitment_tx` (parse txid from raw bytes, off the sync callback). (b) Coop + counterparty closes: funding-outpoint outspend check on the sync tick (≤60s display latency, acceptable). Post-0.2 LDK adds broadcast type tags — revisit then.                                                                                                                                           |
| Commitment fee      | `BumpTransactionEvent_ChannelClose.commitment_tx_fee_satoshis` (`event-handler.ts:556-621`). Pre-close estimate: `Balance_ClaimableOnChannelClose.balance_candidates[confirmed_balance_candidate_index].get_transaction_fee_satoshis()`.                                                                                                                                                                                                                                                                                      |
| Timelock / balances | **Per-monitor, not global**: `chainMonitor.list_monitors()` → `get_monitor(channelId)` → `monitor.get_claimable_balances()` → `Balance_ClaimableAwaitingConfirmations` (`amount_satoshis`, `confirmation_height`). The flat `ChainMonitor.get_claimable_balances(ignored)` carries no channel attribution — unusable per-record. **New API surface; Phase 2 spike.**                                                                                                                                                          |
| Completion signal   | `ChannelMonitor.check_and_update_full_resolution_status(logger)` — LDK's native "fully resolved" check; plus receipt verification in the BDK wallet (see Reconciliation).                                                                                                                                                                                                                                                                                                                                                     |
| Sweep txs           | `Event_SpendableOutputs` (`channel_id` is an Option) + per-descriptor `get_outpoint()`. **Attribution strictly by outpoint, never causality**: persist `channelId` + outpoints + output values alongside descriptors in `ldk_spendable_outputs` (key is currently a bare UUID — no linkage exists); `sweepSpendableOutputs()` returns the outpoints it consumed; fan the sweep txid out to every record owning one. Batched sweeps + the `sweepInProgress` early-return make "the sweep my event triggered" nondeterministic. |
| Needs deposit       | Derived read-through from `RecoveryState` (`src/ldk/recovery/recovery-state.ts`) — never stored.                                                                                                                                                                                                                                                                                                                                                                                                                              |

**Exhaustive `ClosureReason` → record mapping.** Enforced by a unit test enumerating every `ClosureReason_*` subclass exported by `node_modules/lightningdevkit` (LDK discriminates via `instanceof` — the type system can't check exhaustiveness). Default for unknown variants: track if `funding_txo` present.

- Coop: `LegacyCooperativeClosure`, `LocallyInitiatedCooperativeClosure`, `CounterpartyInitiatedCooperativeClosure`
- Force with tx: `HolderForceClosed`, `CounterpartyForceClosed`, `HTLCsTimedOut`, `ProcessingError`, `OutdatedChannelManager`, `PeerFeerateTooLow`
- `CommitmentTxConfirmed`: counterparty close already confirmed — record created with the closing tx discoverable immediately via outspend
- No on-chain tx → **no record**: `DisconnectedPeer`, `FundingTimedOut`, `CounterpartyCoopClosedUnfundedChannel`, `LocallyCoopClosedUnfundedChannel`, `FundingBatchClosure`

### Persistence: singleton map key, IDB-first, merge on conflict

One VSS key (`close_records`) holding a `Record<channelId, SerializedCloseRecord>` map, reusing the `recovery-state.ts` module shape (~100 LOC) with one version ref. **Key-per-record was rejected**: VSS keys are HMAC-SHA256-obfuscated (`src/ldk/storage/vss-crypto.ts:48-66`), so `listKeyVersions()` returns opaque digests — a fresh device can never enumerate `close_record_*` keys, and the manifest-driven restore path (`src/ldk/init.ts:298-403`) only knows monitor keys. A singleton key restores through the existing path trivially and leaks less metadata (no close-count in the key list).

- **IDB-first, VSS best-effort with bounded background retry** — an explicit deviation from the monitor pattern's VSS-first ordering, stated so nobody "fixes" it back: VSS-first exists to gate `channel_monitor_updated`; close records have no such gate (the event handler already returned `ok()`), and VSS-first + indefinite backoff would mean a VSS outage leaves the UI without the record entirely. The designated healer for lost VSS writes is the reconciliation pass. Signal via existing `onVssUnavailable`.
- **VSS 409 conflict = fetch remote value → field-wise merge → rewrite.** The stock `vssWriteWithConflictRetry` re-puts local bytes with a bumped version (blob last-writer-wins) — that loses device A's commitment fee when device B writes its sweep txid. Close records need their own conflict helper.
- **Merge table** (one deterministic `merge(a, b)` used at all three sites — event-time create-or-merge, VSS conflict, startup when both IDB and VSS have data):
  - `txs[]`: union by txid; per-tx fields fill-in (known beats undefined; `confirmedAtHeight` set-once)
  - `createdAt`: min • `completedAt`: set-once • `claimableAtHeight`, `fundingTxo`, `feeSats`: known beats unknown, never downgrade to `'unknown'`/undefined
  - `closeType`/`initiator`/`closureReason`: known beats `'unknown'`
  - Unknown fields from newer schema versions: preserved through decode → merge → encode (old clients must not strip them)
- **Write serialization**: every mutation (event handler, reconciliation, sweep attribution) goes through one per-channel serialized mutator — read → pure merge → write, chained promises per channelId (or reuse `createSerialPersister` from `src/ldk/storage/serial-persister.ts`). Reconciliation gathers facts (Esplora, heights) **outside** the critical section, then re-reads and merges **inside** it — never write back a pre-await snapshot.
- **Store owns a private in-memory map, publishes immutable snapshots.** This is the sync read model that replaces `forceCloseInfoMap`: the `Event_BumpTransaction` handler reads it synchronously (it gates `onRecoveryNeeded` and must never await IDB), records load into memory before the event processor starts, and the handler signals recovery with degraded info when no record is found rather than silently skipping (the current `&& forceCloseInfo` guard drops recovery signaling entirely on event replay after reload — todo #203's real lesson: not "no maps" but _one owner, serialized writes_).
- **React bridge**: IDB write commits → then dispatch a payload-less `zinqq:close-records-changed` event → hook re-reads the snapshot (per `use-recovery.ts`). Never payload-carrying events (stale payload resolving late shows yesterday's state); coalesce concurrent re-reads with a dirty flag.
- Writes happen only on fact changes (a handful per close lifetime, coalesced onto the sync tick) — never per block, never per confirmation.
- New IDB store `ldk_close_records` requires a `DB_VERSION` bump (currently 12, `src/storage/idb.ts:2`).
- Complete records are immutable and quiescent: skipped by reconciliation, polling, and balance matching; merge treats them as absorbing except `txs[]` fill-in.
- Pruning: keep all (bounded by lifetime channel count); the singleton key makes growth a non-issue for restore.

### Reconciliation pass (mandatory; the load-bearing healer)

Runs on startup and on sync ticks, **gated**: only when the tip hash changed (`syncOnce` short-circuits ~90% of ticks today — inherit that; nothing about confirmations can change without a new block) **and** at least one non-complete record exists. Steady state with no pending closes = zero added cost. One narrow exception: while a close's closing tx is still undiscovered, check the funding outspend every tick (Esplora reports unconfirmed spends — this is mempool detection, a short-lived window).

For each non-complete record:

1. Refresh facts: per-monitor claimable balances; outspends of known outpoints; confirmation heights.
2. **Create** missing records from the `channelId → fundingTxo` map diff (see safety net above).
3. Mark `completedAt` **only on positive evidence** — one of:
   - `ChannelMonitor.check_and_update_full_resolution_status()` reports fully resolved, or
   - the expected sweep/closing outputs are visible **in our own BDK wallet** with ≥6 confs (LDK ANTI_REORG_DELAY) — the wallet independently verifies receipt.
   - Absence from claimable balances is **not** evidence (monitor may be archived, unrestored on this device, or never loaded); a spent funding outpoint proves the channel closed, not that funds returned. For records where no outpoints are known and no monitor exists, use a distinct terminal state rendered as "resolved (unverified)" — never launder uncertainty into Complete.
4. Distinguish Esplora **errors** from **empty** outspend results — an outage leaves records stale (healed next pass), never completes them.
5. Escape hatch to the freeze rule: if LDK re-reports a claimable balance for a completed record, reopen it — irreversibility guards against reorg noise, not against ground truth.

**Network discipline** (Esplora concurrency cap is 2, shared with LDK-critical sync): share outspend results with sync step 4 (`chain-sync.ts:87-132` already polls outspends for LDK-watched outputs — pass a per-tick `Map<'txid:vout', OutspendStatus>` to the close-records module rather than double-querying); run close-record queries **after** `syncOnce` returns, outside its 60s abort budget; cap at ~8 outspend queries per pass, round-robin across records. Take a single `list_channels()` snapshot per tick shared with existing consumers. Wire via a new optional `onSynced` callback on `SyncLoopConfig` (the sync loop has no extension point today; keep `chain-sync.ts` free of feature imports, same layering as `onStatusChange`).

**Privacy**: outspend/reconciliation queries use the first-party Esplora proxy **only** — never the `mempool.space` fallback (`src/ldk/config.ts:28`), which would recurringly hand a third party the user's IP + their exact channel set. On proxy failure, records go stale and heal later.

### Event-handler wiring

Injected-callback convention, not direct imports (the recovery precedent: `RecoveryNeededCallback` set via setter, wired in `context.tsx:1147-1157`): define a narrow `CloseLifecycleCallback` interface, all record logic lives in `close-records/`. Preserves the `event-handler.test.ts` testability pattern and keeps the 800-line handler from growing feature logic. Handler stays sync — drain LDK object fields into a primitives-only `CloseSignal` object before anything async (WASM handles must not survive into the persist path).

### History integration

- `UnifiedTransaction` becomes a **discriminated union on `layer`** (`src/hooks/use-transaction-history.ts`) — the close variant carries `status` (derived badge) and `channelId`; flat-type optionals rejected. Both existing consumers already narrow on `layer`, but **audit every `layer` conditional**: `TransactionDetail.tsx:111` has a binary ternary (`'lightning' ? 'Lightning' : 'On-chain'`) that would silently label closes "On-chain" — exhaustive `switch` with `satisfies never` default.
- Close variant amount is `bigint | null`: render "—"/"pending" while unknown. **Never `0n`** ("Received 0 sats" is a lie), and never the capacity fallback. At Complete, amount = measured sum of the close's outputs confirmed in the BDK wallet; pre-complete, `~expectedAmountSats` labeled as estimate. Shared batched sweeps: attribute per-record amounts from the per-descriptor output values captured at `Event_SpendableOutputs` time; fee shown once with a "shared sweep" label (no proportional fee attribution — precision nobody asked for). N records must never each display the full sweep amount.
- `timestamp = record.createdAt`, stable (rows must not hop position as facts arrive).
- **Absorption filter**: build `absorbedTxids = new Set(records.flatMap(r => r.txs.map(t => t.txid)))` once per memo pass — set lookup, not nested scan — and compute it from the **same records snapshot** that emits the group rows (two snapshots = one render where a sweep shows both inside the group and as a bare receive). Invariant test: total sats across history identical with the filter on and off (a misattributed txid must not silently delete a real receive). Interim window before txid discovery (BDK shows a pending receive first) is accepted and documented.
- Records reach the hook via `useCloseRecords()` (window-event pattern), with a referentially stable array between real mutations, added to the memo deps (`onchainBalance`-as-proxy won't recompute when a record learns a txid).
- List row in `src/pages/Activity.tsx`: "Channel close" + derived badge + Bitkit-style remaining-time suffix ("±N days") while timelocked.
- **Detail view is a sibling `ChannelCloseDetail` page, not an extension of `TransactionDetail`** — a close lives ~14 days and must live-update from the records hook; `TransactionDetail`'s `location.state` snapshot pattern is wrong for it. **URL-addressable** (`/activity/close/:channelId`) with history-lookup fallback, so agents and the success screen can deep-link. Contents: per-tx rows (role label, txid, mempool.space link with `rel="noopener noreferrer"`, copy-txid affordance, fee, derived confirmations), timelock countdown (humanized `(claimableAtHeight − tipHeight) × 10 min` → "~N days", exact blocks shown too), total cost once complete, needs-deposit banner → `/recover`.
- Success screen deep-links to the record ("Track progress"); reassurance copy: "Your funds will be accessible in ~N days" (Bitkit's pattern — concrete bound, never "eventually").
- Counterparty-initiated closes surface the moment the record is created, with calm copy: "One of your Lightning channels was closed by the network. Your funds are safe and will return to your wallet automatically." (Breez "Action Required" pattern, softened — no surveyed wallet does this well in-app.)

### Confirm screen (`src/pages/CloseChannel.tsx`)

- **Estimate logic lives in a pure function** `estimateClose(channelIdHex)` in `src/ldk/close-records/estimate.ts` returning `{ feeSats, feePayer, timeline, expectedBackSats, pendingHtlcCount, isAnchor }` with per-field unavailable states — shared by the screen and `window.__closeRecords.estimate` (primitives over workflows; also the only way "estimate failure never blocks closing" is testable without DOM scraping).
- **Fee estimate branches on funder** (most Zinqq channels are Megalith-funded JIT, so the user typically pays **no** closing fee — messaging no surveyed wallet ships, and it turns a scary screen reassuring):
  - Inbound (counterparty-funded): "Closing fee paid by the LSP. You pay only the sweep fee (~X sats)."
  - Outbound coop: `fee_estimator(ChannelCloseMinimum)` × ~700 WU closing-tx weight, labeled rough estimate.
  - Outbound force: commitment fee from `Balance_ClaimableOnChannelClose` (already netted for the funder — don't double-count) + estimated CPFP + sweep.
- Timeline: coop "~minutes once confirmed (requires the LSP online and this app open)"; force "up to ~N days" humanized from `ChannelDetails.get_force_close_spend_delay()` × 10 min/block (fallback copy if None). Fix the inconsistent "several hours" success copy (`CloseChannel.tsx:158`).
- Education copy (Mutiny's parallel two-sentence structure + Zeus's key fact): coop — "Closing this channel moves your balance back to your on-chain wallet and incurs an on-chain fee." force — "Force closing does the same without the LSP's cooperation; it may cost more and your funds are locked for up to ~N days while the network verifies the close. You wait; the other side doesn't."
- Pending HTLCs: "N in-flight payments must settle; the amount returned may change."
- Non-anchor warning via `channel_type.supports_anchors_zero_fee_htlc_tx()` (resolves todos/359).
- Estimate failures never block closing: Phoenix ships this verbatim ("Fee cost could not be estimated.") — render unavailable placeholders, button keeps working. **Hard acceptance test with fee estimator AND balance APIs both failing** — a user who can't force-close because an estimate fetch hangs can't unilaterally exit a misbehaving counterparty.

### Agent-native surface

`window.__closeRecords` (all environments, plain-module functions, wired like `window.__recovery` at `src/ldk/context.tsx:1076-1081`):

```typescript
window.__closeRecords = {
  getAll, // deep-copied records incl. derived status + detail-view URL id
  estimate, // (channelIdHex) => estimateClose result — safe, idempotent
  close, // (channelIdHex) => coop close — same path as the UI
  forceClose, // (channelIdHex) => irreversible; funds locked ~N days — documented like __receive.commit
}
```

Read-only is not enough: the codebase convention already exposes actions (`__recovery.dismiss`, `__receive.commit`), and `CloseChannel` is not even URL-addressable (route-state only, `CloseChannel.tsx:44-48`) — without this, agents can watch closes but never perform one. Agents may listen for `zinqq:close-records-changed`. No dismiss/prune method needed (records aren't dismissible; needs-deposit dismissal stays on `__recovery.dismiss`) — if a hide affordance is ever added to the UI, a matching method ships with it.

## Implementation Phases

Reordered from the draft: the confirm screen has no dependency on the record engine (provisional records were cut) and delivers the most immediate user value — it ships first. Engine + history merge into one phase (an engine with no UI ships nothing).

### Phase 1: Pre-close clarity (confirm screen + education)

- `src/ldk/close-records/estimate.ts` pure function (funder-aware fees, timeline, HTLC count, anchor check, per-field unavailability).
- Confirm screen: estimate display, education copy, non-anchor warning, consistent success copy; visual button-disable while confirming (rest of todo #101 is stale — `closingRef` guard already exists).
- Coop-stall visibility: shutdown-state badge + "Force close instead" affordance in the peers list.
- `window.__closeRecords.estimate` (the accessor object can ship with only this method first).
- Success criteria: inbound JIT channel shows "LSP pays closing fee"; estimates degrade gracefully (both APIs failing → close still works, tested); copy consistent across confirm/success screens.

### Phase 2: Close records engine + history

- **Spike first**: per-monitor `get_claimable_balances()` and `check_and_update_full_resolution_status()` behavior in the WASM bindings (nothing calls these today); verify `balance_candidates` shape; check whether `Balance`/`ChannelDetails` wrappers need explicit `free()` or rely on FinalizationRegistry (per-tick wrapper churn quietly bloats a WASM heap in a week-long PWA session).
- `src/ldk/close-records/` module: domain/serialized types, merge function, serialized per-channel mutator, singleton IDB+VSS persistence (IDB-first, custom conflict-merge helper), in-memory snapshot store, React bridge + `useCloseRecords()`.
- Event wiring via injected `CloseLifecycleCallback`: `Event_ChannelClosed` create-or-merge, `Event_BumpTransaction` commitment txid/fee + sync record lookup replacing `forceCloseInfoMap` (with degraded-info recovery signaling on miss), `Event_SpendableOutputs` outpoint-attributed sweep linkage (extend `ldk_spendable_outputs` schema: channelId, outpoints, values; `sweepSpendableOutputs` returns consumed outpoints).
- `channelId → fundingTxo` map persistence; reconciliation pass (gated, positive-evidence completion, record-creation diff, shared outspend results via `onSynced` extension point, query caps, proxy-only).
- History: `UnifiedTransaction` union + layer-conditional audit, absorption filter + invariant test, Activity row, `ChannelCloseDetail` page (URL-addressable, live-updating), success-screen deep link, counterparty-close copy, full `window.__closeRecords`.
- `DB_VERSION` bump for `ldk_close_records`.
- Success criteria: unit tests — merge table (all three sites), fact-append idempotency (duplicate/out-of-order events are no-ops), ClosureReason exhaustiveness (enumerating `ClosureReason_*` exports), bigint serialization round-trip, absorption invariant; integration scenarios below; Playwright drives a close via `__closeRecords` and asserts the history group renders.

## System-Wide Impact

- **Interaction graph**: `Event_ChannelClosed` → callback → serialized mutator → IDB write → snapshot swap → payload-less window event → `useCloseRecords` re-read → history memo recompute. Sync tick (new-tip only) gains per-monitor balance reads + shared outspend results + reconciliation. No broadcaster changes at all.
- **Error propagation**: VSS unavailability → existing `onVssUnavailable` signaling; record persists never block LDK event processing (sync `ok()`, out-of-band writes); Esplora errors ≠ empty results — errors leave records stale, healed next pass.
- **State lifecycle risks**: crash between `ok()` and persist → healed by reconciliation (records) or created by the funding-txo map diff (missing records). Cross-device concurrent updates to the same map → field-wise union merge; rare lost updates healed by reconciliation. Old-app-version writes → unknown-field preservation + `schemaVersion`.
- **API surface parity**: `window.__closeRecords` (getAll/estimate/close/forceClose) mirrors `__recovery`/`__receive` conventions; `ChannelCloseDetail` is URL-addressable; RecoveryState remains the single writer for needs-deposit.
- **Integration test scenarios**: (1) force close → tab closed 2 weeks → reopen → record completes only on BDK-wallet receipt evidence; (2) two simultaneous force closes, one batched sweep → both records get the shared txid via outpoint attribution, amounts not double-counted; (3) coop close with LSP offline → live shutdown-state badge, no phantom record; (4) close on device A, sweep on device B → VSS conflict merge preserves both devices' facts; (5) CPFP blocked with zero UTXOs → needs-deposit derived on the record view, linking `/recover`, clears after deposit; (6) `Event_BumpTransaction` replay after reload → recovery signaling still fires (no silent skip).

## Acceptance Criteria

- [ ] Confirm screen shows funder-aware cost estimate (labeled), humanized timeline, amount expected back, pending-HTLC note, non-anchor warning, coop-vs-force education; closing works with fee estimator AND balance APIs failing (hard test)
- [ ] Every close path (user coop, user force, counterparty force, HTLC timeout, `CommitmentTxConfirmed`) produces exactly one record; no-tx ClosureReasons produce none; mapping exhaustiveness is test-enforced against the bindings' exports
- [ ] Records survive restart and cross-device restore via the singleton VSS key; duplicate/out-of-order events are no-ops on stored facts; cross-device conflicts merge field-wise (device A's facts + device B's facts both survive)
- [ ] History shows one grouped "Channel close" item per record with derived status badge; `ChannelCloseDetail` (URL-addressable, live-updating) lists each tx with txid, explorer link, copy-txid, fee, derived confirmations, and measured total cost when complete
- [ ] Close-related txs are absorbed without double-listing; absorption invariant holds (total history sats identical with filter on/off); pre-feature closes remain raw receives (no backfill); in-progress amounts render "—", never `0 sats` or capacity
- [ ] Reconciliation completes records only on positive evidence (LDK full-resolution or BDK-wallet receipt ≥6 confs); unverifiable records render "resolved (unverified)"; Esplora outages never complete records; ground-truth reopen works
- [ ] Recordless vanished channels get records created from the funding-txo map diff
- [ ] Blocked sweep shows needs-deposit (derived from RecoveryState) linking to `/recover`; `Event_BumpTransaction` replay after reload still signals recovery
- [ ] Reconciliation/polling run only on new-tip ticks with pending records (zero steady-state cost); outspend queries use the proxy only, shared with sync where outpoints overlap
- [ ] `window.__closeRecords` exposes getAll/estimate/close/forceClose; Playwright drives a close via it
- [ ] New markdown files prettier-formatted (CI checks all markdown)

## Success Metrics

- A user can answer "what did this close cost and where are my funds" entirely in-app for any close initiated after ship.
- Zero support-style confusion moments in testing: no unexplained "Received" entries after closes, no silent counterparty closes, no panic-inducing "eventually" copy.
- Ships three things no surveyed wallet has: funder-aware "LSP pays the closing fee" messaging, an expandable per-tx (commitment/CPFP/sweep) breakdown with fees, and a post-completion total-cost summary.

## Dependencies & Risks

- **Per-monitor balance APIs are new surface** — `get_monitor()`/`monitor.get_claimable_balances()`/`check_and_update_full_resolution_status()` are uncalled today; Phase 2 opens with a spike (including WASM wrapper lifecycle/`free()` behavior).
- **`channel_funding_txo` is an Option** — the funding-txo map + confirm-time capture mitigate; if None everywhere, the record degrades to no-txid-discovery and can only complete via BDK receipt evidence.
- **Monitor archived before reconciliation runs** — completion then rests solely on BDK receipt matching; the "resolved (unverified)" state covers the remainder.
- **`broadcast_transactions` gains type tags post-0.2** — when upgrading, closing-txid discovery can move from outspend-matching to broadcast tags; the matcher is isolated in `close-records/` for that swap.
- **Shared-sweep amount attribution** depends on extending `ldk_spendable_outputs` with values at event time — old persisted descriptors (pre-feature) lack them; those sweeps fall back to "shared sweep" label without per-record amounts.
- Todo #101 is stale (double-submit guard exists); only visual button disable remains.

## Research Insights (wallet-UX survey)

Surveyed: Phoenix, Zeus, Bitkit, Breez, Mutiny, Electrum, ldk-node conventions (sources below).

- **Phoenix**: mutual-close fee estimate with "Fee cost could not be estimated." fallback (validates our non-blocking criterion); force-close screen shows warnings, no estimate — we exceed it; closes are first-class history entries (`ChannelCloseOutgoingPayment`); its vague "after a significant delay" copy generates community panic posts — the counter-example.
- **Zeus**: humanized timelock (`blocks × 10 min` → duration) — our countdown mechanism; best education copy ("the party initiating the force close will have to wait… the other side can spend their funds immediately").
- **Bitkit**: closes reframed as "transfers" between the user's own pockets with "accessible in ±14 days" — our success-screen model; pending activity row with live "(±duration)" suffix.
- **Breez**: per-role txid record (`closedChannelTxID`/`RemoteTxID`/`SweepTxID`) with explorer links — nearest data-model precedent; "Action Required" push on counterparty closes — our (softened) silent-close answer.
- **Mutiny**: parallel coop/force sentence pair — our explainer template; "Funds may take a few days to be swept" note pinned to the history item; its missing-record failure mode ("this channel has likely been closed") is what we're building against.
- **ldk-node**: sweep lifecycle enum maps 1:1 onto our derived badges — external validation of the granularity.

## Sources & References

### Origin

- **Brainstorm:** [docs/brainstorms/2026-07-21-channel-close-transparency-brainstorm.md](../brainstorms/2026-07-21-channel-close-transparency-brainstorm.md) — decisions carried forward: persistent close records (approach A) over derived/polish-only; grouped history item over dedicated status page; needs-deposit links into existing `/recover`; no backfill; labeled rough fee estimate; all close paths covered incl. coop.

### Internal References

- Close UI: `src/pages/CloseChannel.tsx:79-117` (confirm handler), `:253-287` (toggle + warning), `:158` (stale copy), `:44-48` (route-state-only anti-pattern)
- Events: `src/ldk/traits/event-handler.ts:359-393` (ChannelClosed), `:556-621` (BumpTransaction + `forceCloseInfoMap` consumer), `:400-437` (SpendableOutputs), `:369-371` (capacity fallback to avoid), `:740-752` (isForceClose)
- Sweep: `src/ldk/sweep.ts` (batching, `sweepInProgress`); broadcaster: `src/ldk/traits/broadcaster.ts` (sentinel returns `:54,91` — unused by this feature)
- Sync: `src/ldk/sync/chain-sync.ts` (tip short-circuit `:28`, existing outspend polling `:87-132`), `src/ldk/sync/esplora-client.ts` (`MAX_CONCURRENT = 2`), `src/ldk/config.ts:28` (mempool.space fallback — excluded for polling)
- Persistence: `src/ldk/recovery/recovery-state.ts` (IDB-first precedent), `src/ldk/storage/vss-crypto.ts:48-66` (key obfuscation — why key-per-record can't restore), `src/ldk/storage/vss-write.ts:52-75` (blob-LWW conflict helper — insufficient), `src/ldk/storage/serial-persister.ts`, `src/ldk/storage/payment-history.ts` (domain/serialized type split), `src/storage/idb.ts:2` (DB_VERSION)
- History: `src/hooks/use-transaction-history.ts`, `src/pages/Activity.tsx:63`, `src/pages/TransactionDetail.tsx:7,55,111`
- Agent surface: `src/ldk/context.tsx:1069-1095` (`__recovery`, `__receive` conventions)
- Learnings: `docs/solutions/design-patterns/vss-dual-write-persistence-with-version-conflict-resolution.md`, `docs/solutions/design-patterns/bdk-ldk-transaction-history-indexeddb-persistence.md`, `docs/solutions/integration-issues/ldk-event-handler-patterns.md`, `docs/solutions/integration-issues/ldk-wasm-foundation-layer-patterns.md`, `docs/solutions/integration-issues/bdk-ldk-force-close-destination-script-interop.md`
- Related todos: `todos/359` (non-anchor warning — resolved by Phase 1), `todos/203` (mutable recovery-state race — resolved by Phase 2), `todos/101` (stale)

### External References

- LDK 0.2.4-0 TS bindings (ground truth): `node_modules/lightningdevkit/structs/{Event,ClosureReason,Balance,BumpTransactionEvent,ChainMonitor,ChannelMonitor,ChannelManager}.d.mts`
- `Balance` / per-monitor `get_claimable_balances` semantics: docs.rs lightning 0.2.x `chain::chainmonitor::ChainMonitor`, `chain::channelmonitor::{ChannelMonitor, Balance}`
- Wallet-UX survey: [Zeus locales/en.json](https://github.com/ZeusLN/zeus/blob/master/locales/en.json); [bitkit-ios PR #229](https://github.com/synonymdev/bitkit-ios/pull/229) (transfer grouping); Mutiny `public/i18n/en.json` + issues [#1275](https://github.com/MutinyWallet/mutiny-web/issues/1275)/[#1289](https://github.com/MutinyWallet/mutiny-web/issues/1289); [Phoenix 720-block context](https://21ideas.org/en/phoenix/); [ACINQ splicing/fee-transparency post](https://acinq.co/blog/phoenix-splicing-update)
