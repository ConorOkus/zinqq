---
title: 'LDK Spendable-Output Sweep Gets Stuck — From Periodic Retry to Fee-Subsidized PSBT Rescue'
date: 2026-07-22
category: integration-issues
module: src/ldk, src/components
problem_type: integration_issue
component: payments
severity: high
symptoms:
  - "'[Sweep] spend_spendable_outputs failed — outputs may be dust or timelocked, descriptors: 6' recurring on every app start"
  - 'Stuck descriptor count grew to 7 after an LSP force-close added a new entry, with no user-facing signal'
  - 'Spendable outputs stayed stuck in IndexedDB indefinitely — outside an active recovery flow, the sweep only ran at app startup and on new SpendableOutputs events'
  - 'Home screen showed zero indication that recoverable funds were sitting in a pending sweep bundle'
  - 'Near-dust force-close outputs remained permanently stuck even after the retry loop shipped, because the self-funded sweep can never pay its own fee at any rate'
root_cause: missing_workflow_step
resolution_type: code_fix
tags: [ldk, bdk, spendable-outputs, sweep, psbt, fee-subsidy, retry, fund-recovery]
related_components:
  [
    src/ldk/sweep.ts,
    src/ldk/subsidized-sweep.ts,
    src/ldk/psbt-surgery.ts,
    src/ldk/context.tsx,
    src/components/PendingSweepBanner.tsx,
  ]
---

# LDK Spendable-Output Sweep Gets Stuck — From Periodic Retry to Fee-Subsidized PSBT Rescue

## Problem

LDK force-close spendable outputs can end up stuck in the wallet's IndexedDB store indefinitely. When a channel force-closes, LDK emits `SpendableOutputs` events containing `SpendableOutputDescriptor`s that must be swept back into the on-chain wallet with a dedicated transaction — LDK does not do this automatically. Zinqq persists these descriptors to the `ldk_spendable_outputs` IDB store and originally swept them only with `KeysManager.as_OutputSpender().spend_spendable_outputs()` (`src/ldk/sweep.ts`).

That call builds a transaction that spends _only_ the force-close outputs and pays its fee out of their own value. If the bundle's total value can't cover a fee at the prevailing network rate — because the outputs are near-dust, or because more descriptors have piled up increasing weight while the batch stays uneconomical — `spend_spendable_outputs` returns an `Err`, and the descriptors have nowhere to go but back into IDB.

On mainnet this first surfaced as a recurring console line: `[Sweep] spend_spendable_outputs failed — outputs may be dust or timelocked, descriptors: 6`, which then became `descriptors: 7` after an LSP force-close added one more stuck descriptor to the batch. Fixing the missing retry cadence (PRs #174/#175) made stuck-but-eventually-economical batches self-heal, but it left one class of funds permanently stranded: outputs whose value can never cover a fee at any rate, because the transaction that would sweep them has no other source of funds. That gap is what PR #176 closes.

## Symptoms

See frontmatter. In short: a repeating warning log with a growing descriptor count, no user-facing signal that real funds were stuck, a sweep that only ran at boot or on new force-close events, and — even after the periodic-retry fix — a residual category of near-dust outputs that no fee-rate drop could ever rescue.

## What Didn't Work

**Per-entry fallback splitting.** Tried during the original diagnosis: if the whole bundle can't pay for itself, split it into multiple smaller sweep transactions so at least the descriptors that _can_ pay for themselves get swept, leaving only the truly uneconomical remainder stuck. Implemented and reverted before merge — the product decision was that all funds should sweep together in one transaction when economical, not dribble out across multiple broadcasts. `src/ldk/sweep.ts` still documents this as a design constraint: all descriptors are swept together in a single transaction, either everything sweeps or nothing does.

**"Add on-chain funds to cover fees" warning (as of the original incident).** Considered and rejected at the time — correctly, given the code that existed then. `OutputSpender.spend_spendable_outputs()` builds a transaction that spends _only_ the given descriptors plus an optional additional _output_ (not additional inputs). There was no parameter for "also spend these BDK UTXOs" — the fee was necessarily paid out of the swept outputs' own value, so depositing more on-chain BTC would sit alongside the stuck outputs, untouched, and change nothing about whether the sweep succeeded. Prompting the user to add funds would have been actively misleading.

That reasoning held only as long as the sweep used the non-PSBT `spend_spendable_outputs` entry point. It was tracked as a deliberate deferral rather than a dead end: `todos/409-complete-p2-fee-subsidized-sweep-psbt-bdk-inputs.md` recorded the honest alternative — `UtilMethods.constructor_SpendableOutputDescriptor_create_spendable_outputs_psbt(...)` builds an _unsigned_ PSBT from the descriptors instead of a fully-spent transaction, and `KeysManager.sign_spendable_outputs_psbt(descriptors, psbt)` signs LDK's side of it while leaving room for BDK to contribute additional on-chain inputs as fee subsidy before finalizing. Once that path was built (PR #176), "add funds" became true rather than dishonest — but only for the specific, narrow case where the shortfall is fee, not a rescued value below dust.

**Letting the wasm BDK `Psbt`/`TxBuilder` do the input-appending.** Tried and abandoned while building the subsidized path: the wasm BDK `Psbt` class is read-only (no way to add inputs after construction), and `TxBuilder` has no foreign-UTXO support — it can only spend UTXOs the wallet itself selects via its own coin-selection algorithm, not descriptor-derived outputs it doesn't own. Both are documented as the reason for hand-rolling PSBT surgery instead (`src/ldk/psbt-surgery.ts` header comment).

## Solution

**Act one — periodic retry and a passive banner (PR #174, squash-merged as `fb68ef5`; cadence relaxed in PR #175, `a2bb922`).** `src/ldk/context.tsx` added `maybeRetryPendingSweep`, wired into the existing peer/event timer alongside the pre-existing `maybeAutoRecover` (~60s, scoped to an active CPFP-recovery state since PR #128). The new tick first calls `getPendingSweepInfo()` — a cheap IDB read returning `null` when nothing is pending — before doing any address derivation or fee/broadcast work. Initial cadence was ~5 minutes; PR #175 relaxed it to ~60 minutes (`sweepTickCount % 360`), since fee-rate conditions change slowly and startup/event-triggered sweeps still fire immediately when something new arrives. A module-level `lastAttemptFailed` boolean, surfaced through `PendingSweepInfo` and a `SWEEP_STATE_EVENT` window event, drives `src/components/PendingSweepBanner.tsx` to show "waiting to sweep — recovered funds return to your balance automatically when network fees allow" whenever the last attempt failed. Four review findings were folded in before merge: setting the failure flag on every early-return path (not just the branches that looked like failures when the flag was introduced), `AbortSignal.timeout` on the fee-estimate and broadcast fetches (so a hung request can't permanently pin the module-level in-progress guards), `try/catch` around `BigInt(valueSats)` on persisted metadata, and an "At least" prefix on the banner amount whenever any entry undercounts the true pending total.

**Act two — fee-subsidized sweep (PR #176, squash-merged as `e90a088`, with the multi-agent review's fund-safety fixes folded in before merge).** `src/ldk/sweep.ts` now falls back to `attemptSubsidizedSweep` (`src/ldk/subsidized-sweep.ts`) whenever the plain self-funded `spend_spendable_outputs` call fails:

1. **Build the LDK side at the fee floor.** `UtilMethods.constructor_SpendableOutputDescriptor_create_spendable_outputs_psbt(...)` is called at `FLOOR_FEERATE_SAT_PER_KW = 250` (the 1 sat/vB floor), so nearly all swept value survives into the destination output rather than being eaten by LDK's own fee. `create_spendable_outputs_psbt` does **not** enforce dust on its outputs — this was one of the open questions in the todo, resolved by testing against the shipped LDK version — so `subsidized-sweep.ts` adds an explicit gate rejecting any sub-546-sat output before signing.
2. **Append BDK inputs by hand.** Because the wasm BDK `Psbt` is read-only and `TxBuilder` has no foreign-UTXO support, `src/ldk/psbt-surgery.ts` hand-rolls minimal BIP-174 (PSBT v0) parsing and byte-level manipulation — parse, append confirmed wallet P2WPKH inputs plus an optional change output, re-serialize — carrying every pre-existing input/output map as an opaque byte slice so whatever LDK put there survives untouched.
3. **Select inputs largest-first, net-positive only.** `selectSubsidyInputs` in `subsidized-sweep.ts` picks confirmed P2WPKH UTXOs (via `listConfirmedP2wpkhUtxos`) largest-first, up to `MAX_SUBSIDY_INPUTS = 20`, trying a with-change variant first and a changeless variant when the with-change subsidy would exceed the spendable budget. The whole subsidy path is gated net-positive: it only proceeds when the required subsidy is less than what the sweep actually rescues (`ldkOutputSum`, the destination output's value — not the gross swept input sum, which would let a rescue be net-negative by up to the floor fee). The 10,000-sat anchor-CPFP reserve (`ANCHOR_RESERVE_SATS`, kept out of subsidy selection while channels are open) is never spent.
4. **LDK signs first, BDK signs second.** `KeysManager.sign_spendable_outputs_psbt(descriptors, psbt)` signs LDK's inputs; descriptors are re-decoded fresh from serialized bytes for this call, because the wasm bindings consume descriptor objects by value with no clone — the objects already spent on the plain sweep attempt can't be reused. `Wallet.sign(psbt, { trust_witness_utxo: true })` then signs BDK's side, trusting witness_utxo the same way the anchor-CPFP recovery flow already does for LDK-produced PSBTs.
5. **Gate hard before broadcast.** Before either side signs, an independent re-parse (`Psbt.from_string`) checks the assembled PSBT's fee matches the computed fee to the sat. After both sign, the fee is checked again, and `sign()`'s boolean return (not `extract_tx`, which fills in what's available and won't reject an unfinalized input) is the only missing-signature gate.
6. **Verify ambiguous broadcast outcomes against esplora.** The broadcaster maps errors like "inputs missing or spent" to a success sentinel (`already-broadcast`) because for the plain self-funded sweep that's a safe assumption — but here a BDK input concurrently spent by an unrelated wallet action produces the identical error string. Trusting it would delete the descriptors while the funds never moved, so the subsidized path calls esplora's `/tx/{txid}` before believing any non-matching-txid broadcast result.
7. **Reserve spent outpoints and register the tx with the wallet graph.** `markSubsidyInputsSpent` adds the consumed UTXOs to a module-level `spentSubsidyOutpoints` set and calls `bdkWallet.apply_unconfirmed_txs(...)` (persisting the resulting changeset) so BDK's own coin selection — and a second sweep attempt in the ~180s pre-sync window — can't re-select the same input and RBF-evict a transaction whose descriptors were already deleted from IDB. This closes an RBF-eviction window flagged in code review.
8. **Deduplicate replayed descriptors.** `sweepSpendableOutputs` already tracked descriptor byte-hex identity across IDB entries before this change (a replayed event can persist the same descriptor under two keys); the subsidized path reuses that same de-duplicated set.

**Shortfall surfaces as an honest, actionable prompt.** When the subsidy itself would be affordable but the confirmed on-chain balance can't cover it, `attemptSubsidizedSweep` returns `{ status: 'shortfall', shortfallSats, ... }`, which `sweep.ts` surfaces as `needsOnchainFunds`/`shortfallSats` on `PendingSweepInfo`. `PendingSweepBanner.tsx` switches from a passive "waiting" message to an "Add at least X to cover network fees and recover these funds" button that navigates to `/receive`. `sweepNeedsOnchainFunds()` (a cheap synchronous check in `sweep.ts`) tightens the retry cadence in `context.tsx` from ~60 minutes to ~60 seconds (`sweepTickCount % 6`) while blocked purely on funds, so a fresh deposit is picked up promptly instead of waiting up to an hour.

**What remains genuinely stuck.** True dust — value so low that even the LDK-side PSBT at the 250 sat/kw floor produces a sub-546-sat destination output — is rejected by the explicit dust gate and stays stranded. This is a correct limitation, not a gap: no amount of on-chain subsidy changes what LDK itself puts in the destination output, and spending real fees to deliver a sub-dust, unrelayable output would be worse than leaving the funds pending.

## Why This Works

`spend_spendable_outputs` is fundamentally a self-funding operation — success or failure was purely a function of the swept outputs' value versus the current fee rate. That made "stuck" a _conditional_ state that resolves itself once fees drop, provided something keeps checking — which is what the periodic retry (act one) delivered. But some outputs are stuck for a reason fee-rate drops can never fix: their value is simply too small to ever pay a market fee on their own. The PSBT path removes that constraint by making the _transaction_, not the outputs alone, self-funding — LDK contributes the descriptors at a floor rate that preserves nearly all their value, and BDK contributes real fee-paying weight from inputs that were never at risk. Splitting the assembly into "LDK signs its inputs, BDK signs its inputs" mirrors exactly how the anchor-CPFP recovery flow already treats BDK as an external fee source for an LDK-originated PSBT — this isn't a new signing pattern, it's the existing one applied to a second call site.

The net-positive gate (subsidy < rescued value) and the hard-dust gate together define exactly when "add funds" is honest: only when the shortfall is fee, and only when the sweep would actually deliver value once fees are covered. Outside that boundary — true dust, or a subsidy that would cost more than it rescues — the honest answer is still "wait," which is why the passive banner remains the fallback path rather than being fully replaced by the CTA.

The fund-safety hardening (esplora verification of ambiguous broadcasts, outpoint reservation, wallet-graph registration) exists because this path, unlike the plain sweep, spends UTXOs the rest of the wallet can also see and select from. The plain sweep's inputs are LDK-only and invisible to BDK's coin selection; the subsidized sweep's BDK inputs are visible to both the sweep retry loop and ordinary user sends until the next chain sync (~180s), so both consumers need to agree the UTXO is gone the moment it's spent, not three minutes later.

## Prevention

- **A periodic retry only rescues conditions that resolve on their own.** Before shipping a "check again later" loop, be explicit about which failure causes it actually fixes (here: fee-rate drops) and which it can never fix (true dust). The latter needs a structurally different mechanism, not a longer timeout.
- **Re-verify "add funds" reasoning whenever the underlying API changes.** The original rejection of an add-funds prompt was correct for the API in use at the time (`spend_spendable_outputs`, no foreign-input support) and became stale the moment a PSBT-based, externally-fundable path was built. Treat "the API doesn't support X" conclusions as scoped to the specific call, not the whole feature area — revisit them when the call changes.
- **When two independent coin-selection consumers can see the same UTXOs, make a spend visible to both immediately, not just to whichever consumer initiated it.** The subsidized sweep's outpoint-reservation set plus `apply_unconfirmed_txs` registration exists specifically because the retry loop and ordinary sends share the same wallet's `list_unspent()` — a spend known only to the sweep module (not the wallet graph) is a race waiting for the next retry tick or the next user send.
- **A "success" sentinel derived from an error-message match needs a second, independent check before it's trusted to delete data.** The plain sweep's inputs are exclusively LDK's, so "inputs missing or spent" safely means "already broadcast." The subsidized sweep's inputs are shared with the rest of the wallet, so the same string can mean "a concurrent spend beat us to it" — verify against the source of truth (esplora) before deleting the only record of the funds.
- **Gate economic-benefit checks on what's actually delivered, not gross throughput.** Gating "is this subsidy worth it" on the gross swept input value (rather than the value the destination output actually delivers after LDK's own floor-rate fee) would silently allow net-negative rescues up to the size of that fee — always subtract the producer's own cost before comparing.
- **Give anything waiting on external economics (fee rate, timelock maturity, balance) a periodic retry, not just event-triggered or boot-time retry** — and tighten the cadence specifically for the subset of "waiting" states a user can resolve themselves (an on-chain deposit) versus the subset that only time can resolve (fee-rate drift).

## Related Issues

- `todos/409-complete-p2-fee-subsidized-sweep-psbt-bdk-inputs.md` — the completed todo tracking this work end to end, including the open questions (dust enforcement in `create_spendable_outputs_psbt`, fee-weight accounting, subsidize-or-not threshold) and how each was resolved.
- PR #174 (`fb68ef5`) — periodic retry + passive pending-sweep banner.
- PR #175 (`a2bb922`) — relaxed the retry cadence from ~5 minutes to ~60 minutes.
- PR #176 (`e90a088`, review-fix `b5fb44f` folded in before merge) — the fee-subsidized PSBT sweep and the "add funds" CTA documented here.
- `docs/solutions/integration-issues/bdk-ldk-force-close-destination-script-interop.md` — the destination-address derivation this sweep (and its retries) reuse; read together for the full force-close-to-balance funds pipeline.
- `docs/solutions/logic-errors/bdk-address-reveal-not-persisted.md` — the `next_unused_address()`/changeset-persistence rule that keeps both the sweep and the subsidized change address stable across retries.
- `docs/solutions/integration-issues/ldk-event-handler-patterns.md` — the original SpendableOutputs handler design and timer-loop pattern the retry ticks extend.
- `docs/solutions/integration-issues/ldk-trait-defensive-hardening-patterns.md` — prior broadcaster retry/fee-estimator hardening; the fetch-timeout addition in PR #174 is a direct extension of those defensive patterns.
