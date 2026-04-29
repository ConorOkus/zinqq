---
status: cancelled
priority: p3
issue_id: '267'
tags: [code-review, payjoin, validator, upstream-gap, bdk]
dependencies: []
---

# BDK TS bindings don't expose PSBT input fields (sighash, derivations, witness_utxo)

## Problem Statement

`proposal-validator.ts` cannot perform several BIP 78 sender-side checks because BDK's WASM TypeScript bindings only expose `Psbt.unsigned_tx`, `Psbt.fee()`, `Psbt.version`, and `Transaction` structural fields (input/output OutPoints and TxOut value/script). They do **not** expose per-input `witness_utxo`, `sighash_type`, `bip32_derivation`, `redeem_script`, or `witness_script`.

Consequence: We rely 100% on PDK's BIP 78 checklist for sighash type, BIP32 derivation paths, witness vs. non-witness UTXO discipline, and witness/redeem script preservation. There is no defense-in-depth on these from our side.

Threat: A future PDK regression, or a cleverly-malformed PSBT that survives PDK but causes BDK to sign with non-default sighash (e.g., SIGHASH_NONE allowing the receiver to mutate outputs after we sign).

## Findings

- **security-sentinel P2-2**: documented gap. The validator's docstring should explicitly state which checks are PDK-only vs. validator-also.

## Proposed Solutions

### Option 1 (recommended) — Document the limitation, file BDK upstream issue

Add to `proposal-validator.ts` docstring:

```
Limitations: BDK's TS bindings do not expose PSBT input fields
(sighash_type, bip32_derivation, witness_utxo, redeem_script,
witness_script). These checks are delegated to PDK's BIP 78
sender-side checklist. If PDK regresses on any of these, we have
no fallback defense.
```

File a tracking todo with bitcoindevkit/bdk-wallet-web to expose `Psbt.input[i].witness_utxo` etc.

- Pros: future readers know the boundary; upstream fix unblocks defense-in-depth.
- Cons: gap remains until upstream lands.

### Option 2 — Parse the PSBT base64 directly in JS

Reach into the raw PSBT format (BIP 174) in TS and extract input fields without going through BDK.

- Pros: defense-in-depth without waiting on BDK.
- Cons: significant new code; reinventing PSBT parsing in TS; new failure modes.

## Recommended Action

Option 1. File the upstream issue. Document the gap. Defer Option 2 until production telemetry shows it matters.

## Technical Details

- Affected file: `src/onchain/payjoin/proposal-validator.ts:27-30` — extend the docstring
- Upstream: bitcoindevkit/bdk-wallet-web

## Acceptance Criteria

- [ ] Validator docstring enumerates "PDK-only" checks vs. validator-also checks
- [ ] Upstream issue filed with BDK (link recorded here when filed)

## Work Log

## Resources

- PR #143
- security-sentinel P2-2 finding

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
