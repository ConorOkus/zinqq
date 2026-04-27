---
status: complete
priority: p1
issue_id: '251'
tags: [code-review, payjoin, security, validator, hostile-receiver]
dependencies: []
---

# Receiver can graft a sender-owned UTXO not caught by validator

## Problem Statement

PDK's `SenderBuilder::new(psbt, uri)` (`vendor/rust-payjoin/payjoin-ffi/src/send/mod.rs:277`) takes only the PSBT and URI — there is **no `is_mine` callback** plumbed through. PDK's BIP 78 checklist verifies "no original sender input is missing" but cannot verify "no proposal input is _also_ mine" without the wallet's UTXO set.

`validateProposal` only iterates `original.input` for preservation (lines 49-58) — it never checks proposal-side inputs against `wallet.is_mine` for the _input_ scriptPubKeys. If the receiver lists a sender-owned UTXO (e.g., a small unspent change output not selected for this tx) as one of "their" contributions and assigns its value to a receiver-only output, BDK's `wallet.sign` at `context.tsx:240` will sign that input because the descriptor matches.

## Findings

- **security-sentinel P2-1** (which I'm escalating to P1 due to fund-loss vector): the grafted UTXO's value is redirected to a receiver-only output; the validator never iterates `proposal.output` for new outputs (only loops `original.output` for preservation). Net result: sender pays a much larger amount than they intended. Bounded by the size of the smallest sender-owned UTXO the receiver can identify.
- The fee-cap (`originalFee + originalFeeRate*110`, line 61-66) does **not** bound this — it bounds _fee_, not _value_.
- **Practical exploit difficulty**: receiver must learn one of the sender's other UTXOs (e.g., from prior on-chain tx history if the sender has reused an address or sent on-chain to the receiver before). Self-custodial wallets with address reuse hygiene are partially protected, but Zinqq has no enforced reuse prevention.

## Proposed Solutions

### Option 1 (recommended) — Iterate proposal-side inputs and outputs

Add to `validateProposal`:

```ts
// (a) Receiver-added inputs must not be ours.
const origOutpointKeys = new Set(original.input.map((i) => i.previous_output.toString()))
for (const inp of proposal.input) {
  if (origOutpointKeys.has(inp.previous_output.toString())) continue
  // PSBT input witness_utxo isn't exposed in BDK TS — best we can do
  // without that is detect new outputs, see (b).
}

// (b) Any output in the proposal that wasn't in the original must NOT
//     be ours. Catches the redirect side of UTXO grafting.
const origOutputScripts = original.output.map((o) => o.script_pubkey)
for (const propOut of proposal.output) {
  const isOriginal = origOutputScripts.some((s) => scriptsEqual(s, propOut.script_pubkey))
  if (!isOriginal && ctx.wallet.is_mine(propOut.script_pubkey)) {
    return { ok: false, reason: 'receiver added a sender-owned output' }
  }
}
```

This catches the redirect side with surfaces already exposed by BDK. The input-side check requires `Psbt.input[i].witness_utxo.script_pubkey` which BDK's TS bindings don't expose (see todo #271).

- Pros: closes the realistic exploitation path with available surfaces; cheap.
- Cons: doesn't catch UTXO grafting where the receiver also adds a fresh receiver-only output (rare in practice — that's just plain theft, and PDK's BIP 78 check on "fee contribution ≤ max" should bound it).

### Option 2 — Wait for BDK to expose PSBT input fields

Defer until `witness_utxo` is reachable from TS, then check input-side ownership directly.

- Pros: complete coverage.
- Cons: blocks on upstream.

## Recommended Action

Option 1 immediately, plus file todo #271 (BDK upstream gap) for input-side parity.

## Technical Details

- Affected file: `src/onchain/payjoin/proposal-validator.ts` lines 69-95 (output preservation block)
- New tests needed:
  - "rejects when receiver adds a new output owned by sender wallet"
  - "accepts a normal receiver-added receiver-owned output" (existing test 8 covers this)

## Acceptance Criteria

- [ ] New output-side ownership check added
- [ ] Test for receiver-added sender-owned output (rejected)
- [ ] Test for receiver-added receiver-owned output (accepted, existing test still passes)
- [ ] No regression on the 8 existing validator tests

## Work Log

**2026-04-26** — Resolved on PR #143 branch via Option 1 (output-side ownership check).

- Added validator check (f): iterate `proposal.output`, find any output whose scriptPubKey is not present in `original.output`, assert it is NOT `wallet.is_mine`. Catches the redirect side of the UTXO-grafting attack with surfaces already exposed by BDK.
- Added test "rejects when receiver adds a new output owned by the sender (UTXO grafting redirect)" that simulates the attack: receiver grafts a sender-owned UTXO as their "contribution" then adds a fresh output paying that value to a different sender-owned script. Without check (f) the validator would only iterate original outputs and miss this entirely.
- Input-side parity (asserting receiver-added inputs are not ours via `witness_utxo.scriptPubKey`) remains blocked on BDK exposing PSBT input fields — tracked separately in todo #267.

## Resources

- PR #143
- security-sentinel agent report for PR #143
- BIP 78 sender's checklist: https://github.com/bitcoin/bips/blob/master/bip-0078.mediawiki
- PDK source: `vendor/rust-payjoin/payjoin-ffi/src/send/mod.rs:277` (SenderBuilder ctor)
