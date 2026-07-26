---
title: 'False force-close Recover Funds flow after seed+VSS restore (startup scan race, no recovery exit)'
category: logic-errors
module: ldk/recovery
date: 2026-07-25
problem_type: logic_error
component: service_object
severity: high
symptoms:
  - 'After seed+VSS restore, banner claims funds need a deposit to unlock while balance is actually fine and visible on Home'
  - 'Recover Funds screen shows stuck balance of 0 sats (sentinel) with a 5,000-sat deposit prompt'
  - "Force-close recovery state persisted to IDB+VSS never exits once the commitment is superseded by the counterparty's confirmed close"
  - 'Startup anchor-CPFP BumpTransaction replay always sees zero confirmed UTXOs because the fresh BDK wallet has not finished its first scan'
  - 'Recovery exit lags after fix: close-record reconcile skipped records with a known close tx (~10 min wait) and exit check ran on ~60s cadence'
root_cause: async_timing
resolution_type: code_fix
related_components:
  - src/onchain/scan-state.ts
  - src/ldk/recovery/recovery-reconcile.ts
  - src/ldk/close-records/reconcile.ts
  - src/pages/RecoverFunds.tsx
tags:
  - force-close-recovery
  - vss-restore
  - startup-race
  - chain-scan-gate
  - close-record
  - superseded-commitment
  - anchor-cpfp
  - sentinel-value
---

# False force-close Recover Funds flow after seed+VSS restore (startup scan race, no recovery exit)

## Problem

After restoring a wallet from seed + VSS, Zinqq showed a false Force-Close Recovery flow — a "deposit needed" banner and a Recover Funds screen claiming a stuck balance of ₿0 — even though the user's funds were fine: the counterparty's force-close had already confirmed, the Spendable Output had been swept, and the balance was visible on Home. The false state was persisted (IDB + VSS) and never cleared on its own.

## Symptoms

- Home showed the recovery banner: "Your funds are safe / A small deposit is needed to unlock them" (`src/components/RecoveryBanner.tsx:45-47`).
- The Recover Funds screen showed "Stuck balance ₿0" and "Deposit needed ₿5,000" (`src/pages/RecoverFunds.tsx`), while the actual balance was intact and visible on Home.
- The state reappeared on every restore of this wallet, and survived reloads indefinitely — there was no path by which it could clear except a successful sweep, which could never happen (nothing was stuck).
- Per this session's diagnosis: our own commitment tx had been recorded at broadcast time but could never confirm, because the counterparty's commitment had already spent the funding output and confirmed.
- After the fix, the startup log shows the deferral line when the race is dodged: `[LDK Event] BumpTransaction: no UTXOs but initial scan pending — deferring recovery signal` (`src/ldk/traits/event-handler.ts:740`), and the exit reconcile logs `[Recovery] closing tx confirmed for all recovery channels — CPFP no longer needed, clearing recovery state` (`src/ldk/context.tsx:1421-1423`) when it clears.

## What Didn't Work

The pre-#179 discovery trap set the stage: close-record reconcile's funding-outspend discovery (step (a) in `src/ldk/close-records/reconcile.ts`) was gated on "no KNOWN close tx". This record already held our own commitment tx, recorded at broadcast time by the BumpTransaction branch — so discovery never ran, and the counterparty's actual confirmed close tx was never found. Discovery must re-run until a close tx has CONFIRMED, not merely until one is known: an unconfirmed recorded commitment can be superseded by the counterparty's, and only the confirmed funding-output spend is ground truth.

The first shipped iteration fixed that step (a) gate and contained the scan-completion gate, the exit reconcile, and the nullable stuck balance — its exit condition was correct. It still failed field testing: the user reloaded, still saw the banner, and reported the fix as not working. The exit reconcile was starved of facts by two residual latency gates:

1. **Mismatched fast-path predicate.** The pass-level every-tick "mempool window" exception still used the old "no known close tx" predicate — so without a new block, the whole reconcile pass returned early and the fixed step (a) never even ran. Discovery was delayed to block cadence (~10 min), well past any window a user would wait after a reload. Fast-path predicates must stay in lockstep with the steps they gate.
2. **Exit cadence.** The recovery exit check originally ran on the ~60s sweep cadence rather than every ~10s tick, adding up to another minute after the record healed.

The lesson: a correct exit condition is not a fix until the data it reads converges within the window a user will actually wait.

This bug also has direct ancestry in earlier sessions (session history):

- The mutable `forceCloseInfoMap` lost recovery signaling whenever LDK replayed events after a reload — the reason close records are hydrated before the event processor starts. The repeatedly-relearned lesson: **LDK replays unresolved events on every restart**; any handler that treats an event as "a new close is happening now" mis-fires after restore. This false positive is the same class — a replayed `BumpTransaction` treated as a fresh emergency.
- Several earlier "entered a stuck state, no path out" shapes preceded this one: `claimableAtHeight` never being written kept force closes pending forever, and a role mismatch (receipt evidence not accepting `commitment`-role txs) stuck offline coop closes. None of those exits covered a commitment superseded by the counterparty's confirmed close — the gap this fix closed.

## Solution

Merged in PR #179, four coordinated changes:

**1. Scan-completion gate.** New module `src/onchain/scan-state.ts` holds a module-level per-session flag; `fullScanBdkWallet` sets it after the first successful full scan (`src/onchain/init.ts:98`). The `Event_BumpTransaction` branch defers the recovery signal while the initial scan is pending (`src/ldk/traits/event-handler.ts:731-742`):

```ts
if (!hasConfirmedUtxo && onRecoveryNeeded && recoveryContext) {
  if (isInitialScanComplete()) {
    onRecoveryNeeded({ ...recoveryContext, reason: '...' })
  } else {
    console.log(
      '[LDK Event] BumpTransaction: no UTXOs but initial scan pending — deferring recovery signal'
    )
  }
}
```

Deferring is safe because LDK re-yields bump events on each new block until the claim confirms — a genuinely stuck close re-triggers after the scan lands (rationale documented at `src/onchain/scan-state.ts:1-15`).

**2. Exit reconcile.** New pure helper `closeConfirmedForAllChannels()` in `src/ldk/recovery/recovery-reconcile.ts:23-37`: recovery clears when every recovery channel's Close Record either has `completedAt` set or contains a closing/commitment tx with `confirmedAtHeight`. Missing records or unconfirmed close txs keep recovery active (conservative: never clear a deposit ask we can't disprove). Wired as `maybeClearResolvedRecovery()` in `src/ldk/context.tsx:1413-1449`, run on EVERY ~10s tick (`src/ldk/context.tsx:1549`) — it's cheap (one IDB read + in-memory record lookups) — with a log-on-change diagnostic naming WHY recovery persists (`no close record` / `record lacks fundingTxo` / `no confirmed close tx yet`).

**3. Supersession discovery.** In `src/ldk/close-records/reconcile.ts`, both step (a) and the every-tick mempool-window predicate now key on "no CONFIRMED close tx" instead of "no known close tx". Before/after in essence:

```ts
// before: discovery skipped once ANY close tx was known
const hasCloseTx = record.txs.some(
  (tx) => tx.role === 'closing' || tx.role === 'commitment'
)
if (!hasCloseTx && record.fundingTxo) { ... }

// after: re-check the funding outspend until a close tx has CONFIRMED
const hasConfirmedCloseTx = record.txs.some(
  (tx) => (tx.role === 'closing' || tx.role === 'commitment') && tx.confirmedAtHeight !== undefined
)
if (!hasConfirmedCloseTx && record.fundingTxo) { ... }
```

(`src/ldk/close-records/reconcile.ts:181-200`; matching mempool-window predicate at `:105-113`, so a superseded-commitment record is re-checked every tick instead of waiting ~10 min for the next block. Merge unions by txid, so re-discovering an already-recorded tx just fills in its confirmation height.)

**4. Nullable stuck balance.** `RecoveryNeededInfo.localBalanceSat` (`src/ldk/traits/event-handler.ts:96`) and `RecoveryState.stuckBalanceSat` (`src/ldk/recovery/recovery-state.ts:15`) are `number | null`. The event handler produces `null` (not 0) when the Close Record is missing or predates the balance fact (`src/ldk/traits/event-handler.ts:676-681`); aggregation in `enterRecovery` is null-poisoned — an unknown on either side makes the sum null rather than a fake partial total (`src/ldk/recovery/use-recovery.ts:58-61`); the UI renders "Unknown" for null (`src/pages/RecoverFunds.tsx:67`).

Verification: field-tested on the live wallet — the startup log showed the deferral line, and the stale persisted recovery state cleared seconds after the close record healed. 676 unit tests pass, including a test reproducing the exact supersession scenario ("discovers a superseding close tx when the recorded commitment never confirmed", `src/ldk/close-records/reconcile.test.ts:135`) and pure-helper tests in `src/ldk/recovery/recovery-reconcile.test.ts`.

## Why This Works

Four distinct root causes, each addressed by its own fix:

- **Replay-vs-scan race.** On restore, LDK replays chain-monitor events — including the anchor-CPFP `Event_BumpTransaction` for a force-close commitment — as soon as event processing starts, before the freshly created BDK wallet has scanned the chain. At that moment `list_unspent()` is empty BY CONSTRUCTION, so the pre-check "does the wallet have confirmed UTXOs for CPFP?" (`src/ldk/traits/event-handler.ts:707-721`) was false on every restore regardless of real funds, and recovery was entered unconditionally. The scan gate makes the pre-check's answer meaningful before acting on it, and LDK's re-yield behavior guarantees no genuine recovery is lost by deferring.
- **Entry-only state machine.** The persisted recovery state had entry paths but only one exit: a successful sweep (`maybeAutoRecover`, `src/ldk/context.tsx:1455-1495`). In the supersession case a sweep can never fire from this state — our commitment can never confirm, so CPFP is moot — and the state persisted forever. The exit reconcile adds the missing chain-truth exit: once ANY closing tx for every recovery channel confirms (ours or the counterparty's), the deposit ask is provably wrong and the state clears.
- **Sentinel rendering.** A missing `expectedAmountSats` on the Close Record was collapsed to 0 and printed as "Stuck balance ₿0" — a sentinel displayed as a fact, which made the (already false) screen actively alarming. Null propagation end-to-end lets the UI say "Unknown" instead of asserting a wrong number.
- **Confirmed-vs-known discovery.** "A close tx is known" is not the same fact as "the close is resolved". Our own broadcast is recorded optimistically at broadcast time; the counterparty's commitment can supersede it. Only a CONFIRMED spend of the funding output is ground truth, so discovery must key on confirmation, and the fast-path (every-tick) predicate must match, or the exit reconcile converges only at block cadence.

The fixes compose: the gate prevents the false entry on future restores; discovery + the exit reconcile heal any already-persisted false state (including ones synced down from VSS); the nullable balance keeps the UI honest during whatever window remains.

## Prevention

- **Gate wallet-state pre-checks on initial scan completion.** Any decision of the form "the wallet has no X, therefore act" is invalid before the first full scan — on restore, emptiness is true by construction. Route such checks through `isInitialScanComplete()` (`src/onchain/scan-state.ts`), and prefer deferring when the triggering event is re-delivered (as LDK bump events are) so nothing is lost.
- **Treat every LDK event as possibly replayed, never as "happening now".** LDK replays unresolved events on every restart; handlers must be idempotent and must not infer freshness from delivery (session history — the same class previously lost recovery signaling via `forceCloseInfoMap` and double-persisted `SpendableOutputs` descriptors across restarts).
- **Persisted "action needed" states need a chain-truth exit reconcile, not just an entry path.** Whenever a user-facing prompt is persisted (especially to VSS, where it follows the user across restores), ship the exit condition in the same change: a cheap, frequently-run check against on-chain facts that clears the state when its premise no longer holds, plus a log-on-change diagnostic naming why it persists (`maybeClearResolvedRecovery`, `src/ldk/context.tsx:1413-1449`). Then check the end-to-end convergence latency — every cadence between "chain fact exists" and "user sees it" multiplies; the first iteration here failed field testing purely on latency.
- **Never render sentinel values as facts.** If a number can be unknown, its type is `number | null` all the way from source to screen, aggregation is null-poisoned (never a silent partial sum), and the UI renders "Unknown" (`src/ldk/recovery/use-recovery.ts:58-61`, `src/pages/RecoverFunds.tsx:67`). A defaulted 0 in a funds context reads as "your money is gone".
- **Discovery loops must key on CONFIRMED evidence when broadcasts can be superseded.** "We already know a tx" is a broadcast-time claim, not a resolution. Any loop that stops discovering once a candidate is recorded will miss the competing tx that actually won; keep re-checking the authoritative source (the funding outspend) until something has confirmed (`src/ldk/close-records/reconcile.ts:174-200`). And keep fast-path predicates in lockstep with the steps they gate (`:99-113`).

The behavior is locked in by tests: the exact supersession scenario in `src/ldk/close-records/reconcile.test.ts:135` (recorded own commitment never confirms; counterparty's tx discovered as confirmed, clearing the false banner), the exit-condition matrix in `src/ldk/recovery/recovery-reconcile.test.ts`, and null-poisoned aggregation in `src/ldk/recovery/use-recovery.test.ts`.

## Related Issues

- `docs/solutions/integration-issues/ldk-spendable-output-sweep-stuck-retry-and-fee-semantics.md` — the sibling sweep-side recovery machinery sharing the same `src/ldk/context.tsx` tick loop this fix extends.
- `docs/solutions/integration-issues/bdk-ldk-force-close-destination-script-interop.md` — the previous restore-pipeline ordering fix (eager BDK init before LDK deserialization); this doc covers the next ordering gap in the same pipeline.
- `docs/solutions/integration-issues/ldk-event-handler-patterns.md` — LDK event replay/acknowledge patterns (note: predates anchor-CPFP BumpTransaction handling and this fix's scan gate).
- `docs/solutions/logic-errors/vss-restore-background-persist-race.md` — the other known wallet-restore ordering bug.
- `docs/solutions/logic-errors/bdk-address-reveal-not-persisted.md` — establishes the always-full-scan-on-init behavior whose pre-scan window this fix gates.
- Companion reconcile rules established in the close-records sessions but not committed as standalone docs (session history): measured facts (wallet receipt evidence) short-circuit before derived gates like phantom timelocks; and `to_self_delay` binds only the broadcaster, so a counterparty-confirmed close leaves our funds nearly unencumbered — which is why exiting recovery quickly on supersession is safe.
- PR chain: #171/#172 (close records engine), #174/#175 (sweep retry + banner), #176 (fee-subsidized sweep), #177 (wallet-owned StaticOutput sweep poisoning), #179 (this fix).
