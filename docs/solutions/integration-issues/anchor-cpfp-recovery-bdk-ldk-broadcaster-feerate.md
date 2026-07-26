---
title: 'Anchor channel CPFP recovery: three coupled bugs (signing, rebroadcast, fee overpay)'
category: integration-issues
tags: [ldk, bdk, anchor-channels, cpfp, force-close, fee-estimation, broadcaster, psbt]
date: 2026-05-06
module: ldk
symptom: 'Force-closed anchor channel commitment stuck in mempool, then overpaid 30x once CPFP cleared (~13,358 sats burned)'
root_cause: 'BDK signer rejected witness-only PSBT; broadcaster retried already-confirmed txs on RPC -25/-27; UrgentOnChainSweep mapped to Esplora 1-block target which spikes in quiet mempools'
prs: [151, 152]
---

# Anchor channel CPFP recovery: three coupled bugs

## What happened

A user's anchor channel force-closed on mainnet at a moment when the on-chain
mempool was at 1 sat/vB. The wallet's auto-CPFP was supposed to fee-bump the
LSP-broadcast commitment transaction so it would confirm. Instead it sat
stuck in the mempool for hours. Three coupled bugs in the
anchor-CPFP recovery path surfaced in sequence — each one masking the next:

1. BDK refused to sign LDK's CPFP PSBT because the standard CVE-2020-14199
   hardening rejected the witness-only inputs LDK builds for native-SegWit
   anchor outputs.
2. Once signing was fixed, the broadcaster retried the (now-confirmed)
   commitment + child transactions on every wallet launch and logged each
   retry as a critical failure.
3. Once retries were quieted, the CPFP child paid **30× the going rate**
   because the fee estimator was reading Esplora's 1-block target — which
   reflects what recent high-priority transactions paid, not what's
   currently being mined.

The first two bugs prevented the channel from confirming. The third bug
ensured that once it did confirm, real user funds were burned to miner
fees. Field repro:

> Tx `33582b556153759cc08ef94c0dbaeba12a6f2f7c8f96672a2692c90f556a9e01`
> paid **13,358 sats** ($10.89) at **30.4 sat/vB effective** when the
> network was confirming blocks at 1 sat/vB. mempool.space tagged it
> "Overpaid 30×".

These were fixed by PRs **#151** (signing + broadcaster) and **#152**
(fee estimator). The patterns are documented below so the next force-close
in production doesn't have to rediscover them.

---

## Bug 1: PSBT signing fails with "Missing non-witness UTXO"

### Symptom

```
[BDK WalletSource] sign_psbt called, PSBT size: 215
[BDK WalletSource] sign_psbt failed Error: Missing non-witness UTXO
[LDK lightning::events::bump_transaction] Failed bumping commitment
  transaction fee for 4c2b463f...
```

Repeats every block tick while LDK retries the bump.

### Root cause

LDK's `BumpTransactionEventHandler` builds anchor-CPFP PSBTs and populates
only `witness_utxo` for the wallet input — it doesn't carry the full
previous transaction. For native-SegWit (P2WPKH) inputs that's
cryptographically sufficient.

BDK's default `SignOptions` enforces presence of `non_witness_utxo` as a
[CVE-2020-14199](https://github.com/spesmilo/electrum/security/advisories/GHSA-4fh4-hx35-r355)
mitigation: a malicious external PSBT producer could otherwise hide the
real fee from a hardware wallet signer. The threat model is **untrusted
PSBT producers**. With the default, every anchor CPFP attempt aborted at
signing.

### Fix

`src/ldk/traits/bdk-wallet-source.ts`:

```ts
// before
const psbt = Psbt.from_string(base64)
bdkWallet.sign(psbt, new SignOptions())
const signedTx = psbt.extract_tx()
```

```ts
// after — see the full comment in the file for the safety argument
const psbt = Psbt.from_string(base64)
const signOpts = new SignOptions()
signOpts.trust_witness_utxo = true
bdkWallet.sign(psbt, signOpts)
const signedTx = psbt.extract_tx()
```

### Why this is safe

CVE-2020-14199 protects against _external_ PSBT producers. Here LDK
constructs the PSBT in-process from on-disk channel state we already
trust, with our own keys, sending change to our own
`get_change_script()`. There is no external producer in the trust
chain. Native-SegWit inputs only need `witness_utxo` cryptographically.
`trust_witness_utxo: true` adds zero attack surface for this code path.

---

## Bug 2: Re-broadcast of confirmed CPFP package logs as critical failure

### Symptom

```
[LDK Broadcaster] Pending broadcasts: 2 retrying, 0 expired (discarded)
[LDK Broadcaster] primary attempt 1/5 failed: Error: HTTP 400:
  sendrawtransaction RPC error -27: Transaction outputs already in utxo set
... 4 more primary, 3 fallback ...
[LDK Broadcaster] Pending broadcast retry failed: Error: All broadcast
  attempts failed for tx 0200000000010118...
```

Logged at every wallet launch, indefinitely, even though the transactions
are safely on-chain.

### Root cause

After a CPFP child confirms, LDK keeps re-issuing the commitment + anchor
child via `broadcast_transactions` until it considers them sufficiently
buried. esplora / mempool.space respond with Bitcoin Core RPC `-25`
(`bad-txns-inputs-missingorspent` — the inputs are spent by the
now-confirmed tx itself) or `-27`
(`Transaction outputs already in utxo set` — a tx with the same outputs
is already on-chain). Both mean "you already won."

The existing "known" detection in `postTxToEsplora` only matched a few
literal substrings (`txn-already-known`, `transaction already in block
chain`, etc.). `-25`/`-27` fell through to the full retry path
(5 primary + 3 fallback) and ended in
`captureError('critical', 'Broadcaster', 'Broadcast failed after all retries')`,
hiding actual broadcast failures in the noise.

### Fix

`src/ldk/traits/broadcaster.ts`:

```ts
// after — extended substring match in postTxToEsplora
if (
  lower.includes('transaction already in block chain') ||
  lower.includes('txn-already-known') ||
  lower.includes('txn-already-confirmed') ||
  lower.includes('insufficient fee, rejecting replacement') ||
  // RPC -27: outputs already in UTXO set → tx (or a sibling) is on chain.
  lower.includes('outputs already in utxo set') ||
  lower.includes('-27') ||
  // RPC -25: inputs missing or spent → already confirmed (or superseded).
  lower.includes('bad-txns-inputs-missingorspent') ||
  lower.includes('-25')
) {
  return { status: 'known' }
}
```

The loose `-27` / `-25` substring fallbacks cover both Esplora's
flat-string error format and mempool.space's JSON shape
(`{"code":-27,"message":"..."}`).

### Why this is safe

For a persisted-pending broadcast, both `-25` and `-27` mean a transaction
with the same effect is already on-chain — retrying cannot improve the
outcome. Returning `'known'` lets `drainPendingBroadcasts` clear the IDB
entry just like a successful broadcast would, so no stale rebroadcast
queue accumulates. Genuine broadcast failures (fee-too-low on a fresh
tx, signature errors, network 5xx) still fall through to the retry path.

The fix is regression-tested at `src/ldk/traits/broadcaster.test.ts`
("case-insensitive idempotency").

---

## Bug 3: Anchor CPFP overpays 30× during quiet mempool

### Symptom

No log. The bug surfaced only in the field via mempool.space's
"Overpaid Nx" annotation on the confirmed CPFP transaction:

```
Tx:               33582b556153759cc08ef94c0dbaeba12a6f2f7c8f96672a2692c90f556a9e01
Fee:              13,358 sats ($10.89)
Effective rate:   30.4 sat/vB ("Overpaid 30x")
Fee rate (child): 74.7 sat/vB
Network:          1 sat/vB blocks
```

### Root cause

`targetToBlocks(UrgentOnChainSweep)` in `src/ldk/traits/fee-estimator.ts`
returned `1`. Esplora's 1-block estimate is the rate that **recent
high-priority transactions paid**, not the rate currently needed to
confirm. In a quiet mempool a single 75 sat/vB outlier can pull the
1-block reading wildly above the actual confirmation rate even though
1 sat/vB blocks are clearing fine.

LDK applied this directly to the CPFP child without any sanity bound,
burning ~30× the necessary fee. The
`MaximumFeeEstimate` ceiling (50,000 sat/kW = 200 sat/vB) was not low
enough to catch it.

### Fix

`src/ldk/traits/fee-estimator.ts`:

```ts
// before
case ConfirmationTarget.LDKConfirmationTarget_UrgentOnChainSweep:
  return 1
```

```ts
// after — full safety argument inline in the file
case ConfirmationTarget.LDKConfirmationTarget_UrgentOnChainSweep:
  return 3
```

The same PR also extracted `computeFeeRateSatKw(target)` from
`createFeeEstimator()` so the floor-and-cap logic is unit-testable
without booting the LDK WASM bindings. Regression tests at
`src/ldk/traits/fee-estimator.test.ts` lock in the 3-block target
(asserting that `getCachedFeeRate` is called with `3`, NOT `1`).

### Why this is safe

`UrgentOnChainSweep` covers anchor CPFP, justice transactions, and
HTLC-success / HTLC-timeout claims. All three have substantial safety
windows:

| Use of `UrgentOnChainSweep`             | Window before counterparty can act          |
| --------------------------------------- | ------------------------------------------- |
| Anchor commitment CPFP (this incident)  | Full `to_self_delay`, typically 144+ blocks |
| Justice transaction (revoked output)    | Same — bounded by `to_self_delay`           |
| HTLC-success / HTLC-timeout near expiry | Still protected by `MaximumFeeEstimate`     |

Going from 1-block to 3-block adds at most ~30 minutes of confirmation
latency in pathological cases. That's negligible against a 24h+ safety
window. The 2,500 sat/kW floor (10 sat/vB) in `DEFAULT_FEE_RATES` still
guarantees we're well above dust-relay even if the cached estimate goes
stale.

`MaximumFeeEstimate` keeps its 1-block target — it's intended as a
sanity ceiling, not as a rate to actually pay.

---

## Prevention

### What we should have caught earlier

The anchor-CPFP path is the wallet's last line of defense, yet it had
never been exercised under the conditions that actually trigger it:
**mainnet + low-fee mempool (≤2 sat/vB) + a wallet with a single small
UTXO**. Pre-deploy testing covered the happy path on regtest with
synthetic fees and abundant UTXOs — none of those reproduce any of the
three bugs.

**Force-close drill (run pre-deploy, on mainnet, against a throwaway node):**

1. Open one anchor channel against Megalith (sole LSP since PR #167; LQwD, the incident-era LSP, was removed) with ≤50k sat capacity.
2. Drain the on-chain wallet to a single UTXO ≈ 2× the channel reserve.
3. Wait for a low-fee mempool window (≤2 sat/vB at 3-block target via
   mempool.space).
4. Force-close from the counterparty side (so we receive
   `BumpTransactionEvent`).
5. Capture and assert:
   - PSBT signs on first attempt.
   - Broadcaster confirms within 2 blocks.
   - **Effective sat/vB within 2× of the 3-block target.**
   - No `-27` / `-25` retry storms in logs.
   - Total fee burn < 2,000 sats.
6. Re-launch the wallet after confirmation; assert zero
   `Broadcaster` critical logs.

### Tests / monitoring to add

- **Bug 1 (signing):** add an integration test that constructs a
  realistic LDK CPFP PSBT (witness_utxo only, anchor input), calls
  `signPsbt`, and asserts no throw. Wires `trust_witness_utxo` through
  the real BDK binding.
- **Bug 2 (broadcaster idempotency):** unit-tested by PR #151 (3 new
  cases for `-27` / `-25`). Add a runtime alert: any
  `[LDK Broadcaster] Broadcast failed after all retries` log within 5
  minutes of a wallet launch is a regression signal.
- **Bug 3 (fee overpay):** beyond PR #152's regression tests, emit a
  per-CPFP runtime invariant log:
  `cpfp.effective_sat_vb / cpfp.target_sat_vb`. Alert on
  `ratio > 5×` over any 24h window.
- **The integration gap:** an end-to-end anchor-CPFP test
  (`src/ldk/__tests__/anchor-cpfp.e2e.test.ts`) that spins up an LDK
  node + BDK wallet against regtest with a fee-estimator stub returning
  realistic Esplora-shaped responses (1-block: 30, 3-block: 2, 6-block: 1),
  triggers `BumpTransactionEvent`, and asserts: PSBT signs, broadcast
  succeeds idempotently on replay, **effective fee rate equals the
  3-block stub value ±10%**. One test, all three bugs caught.

### Architectural hardening

**Fee-rate sanity-check middleware before broadcast.** Wrap
`broadcaster.broadcastTransactions` in a guard that computes
`effective_sat_vb` from the tx and compares it against a freshly-fetched
3-block estimate; if `ratio > 5×`, refuse the broadcast and surface a
recoverable error to LDK (which retries on the next block). This is a
single chokepoint that defends against _any_ upstream fee miscalculation
— wrong target, stale cache, Esplora returning garbage, future LDK bugs
we haven't hit yet — without auditing every fee-rate call site. The
13,358-sat burn would have been a 200-sat retry instead, and the same
guard protects HTLC timeouts, justice txs, and any future on-chain
action.

---

## Related solutions docs

- Anchor-channel negotiation was a prerequisite fix for this incident
  (its doc never landed on main under the retired keep-local convention).
- The `UrgentOnChainSweep` feerate-floor rationale now lives inline at
  `src/ldk/traits/fee-estimator.ts`; see
  [`ldk-lqwd-announce-preference-and-non-anchor-feerate-floor.md`](./ldk-lqwd-announce-preference-and-non-anchor-feerate-floor.md)
  for the adjacent non-anchor floor. That earlier floor fix is the direct
  precedent; the 3-block target switch in this incident is the successor
  problem after the floor fix proved insufficient in a different direction.
- [`ldk-trait-defensive-hardening-patterns.md`](./ldk-trait-defensive-hardening-patterns.md) —
  background. The broadcaster's substring-based "known" detection is an
  instance of these patterns; this incident extends them.
- [`bdk-ldk-force-close-destination-script-interop.md`](./bdk-ldk-force-close-destination-script-interop.md) —
  see-also. Routes force-close and CPFP sweep outputs to the BDK wallet;
  the BDK PSBT signing fix here is the lower layer.
- [`bdk-wasm-onchain-send-patterns.md`](./bdk-wasm-onchain-send-patterns.md) —
  see-also. PSBT build-sign-broadcast pipeline; `trust_witness_utxo`
  applies to that pipeline too.
- [`ldk-event-handler-patterns.md`](./ldk-event-handler-patterns.md) —
  see-also. `BumpTransactionEvent` flows through this event-handler
  pattern.
- The fee-estimator overpay was triggered by the `getCachedFeeRate(1)`
  reading; the fee cache itself was working correctly, the wrong target was
  being asked (its batching/caching doc never landed on main — see
  `docs/plans/2026-04-07-001-feat-esplora-request-batching-caching-plan.md`).
- [`ldk-event-handler-multi-lsp-trust-set.md`](./ldk-event-handler-multi-lsp-trust-set.md) —
  context. The force-close happened on an LQwD-opened anchor channel.
- [`ldk-spendable-output-sweep-stuck-retry-and-fee-semantics.md`](./ldk-spendable-output-sweep-stuck-retry-and-fee-semantics.md) —
  successor. The other half of the pipeline: this doc covers fee-bumping
  the commitment to confirmation; that one covers sweeping the spendable
  outputs afterward.
- [`../logic-errors/force-close-recovery-false-positive-on-vss-restore.md`](../logic-errors/force-close-recovery-false-positive-on-vss-restore.md) —
  successor. Recovery entry is now gated on Initial Scan completion so a
  restored wallet doesn't false-trigger the deposit ask this incident's
  recovery flow introduced.
- [`lsps2-jit-receive-channel-config.md`](./lsps2-jit-receive-channel-config.md) —
  context. `accept_underpaying_htlcs=true` is set for LSPS2 channels;
  related to the disclosure UX in PR #150 but distinct from this
  recovery path.

## References

- **PR #151** — `trust_witness_utxo: true` + broadcaster `-27`/`-25` detection.
- **PR #152** — `UrgentOnChainSweep` 1-block → 3-block + extracted
  `computeFeeRateSatKw` for testability.
- **Field tx** — `33582b556153759cc08ef94c0dbaeba12a6f2f7c8f96672a2692c90f556a9e01`
  (mainnet, F2Pool, 10 confirmations at write time).
- **CVE-2020-14199** — PSBT fee-siphon attack on hardware wallet signers.
- **bLIP-52** — LSPS2 spec (anchor channels are the underlying protocol).
