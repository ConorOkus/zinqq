---
status: pending
priority: p2
issue_id: '409'
tags: [sweep, force-close, onchain, ldk, bdk, ux]
dependencies: []
---

# Fee-subsidized sweep: rescue uneconomical outputs with on-chain inputs (PSBT path)

## Problem Statement

The sweep (`src/ldk/sweep.ts`) uses `OutputSpender.spend_spendable_outputs()`,
which builds a transaction spending _only_ the LDK force-close outputs — the
fee comes out of the swept value itself. When the pending outputs can't cover
the fee at prevailing rates, the sweep fails and the funds sit in IDB waiting
for a low-fee window (surfaced via `PendingSweepBanner` + the ~5min retry
loop added on branch `fix/sweep-pending-retry-banner`). True dust may never
become economical and is effectively stranded.

## Proposed Solution

Build a fee-subsidized sweep using the PSBT path the bindings already expose:

- `UtilMethods.constructor_SpendableOutputDescriptor_create_spendable_outputs_psbt(descriptors, outputs, change_destination_script, feerate_sat_per_1000_weight, locktime)`
  → returns (PSBT bytes, expected max weight)
- `KeysManager.sign_spendable_outputs_psbt(descriptors, psbt)` → LDK signs its
  inputs

Then have BDK contribute on-chain inputs to cover the fee shortfall and sign
its side (the anchor-CPFP recovery flow already wires BDK up as a coin source
via `bdk-wallet-source.ts` / `WalletSourceSync` — similar plumbing).

UX: when the subsidized sweep is possible but the on-chain balance can't
cover the fee, upgrade the pending-sweep banner to prompt the user to add
on-chain funds (this is the point at which "add funds" becomes an honest
suggestion — with the current non-PSBT sweep it would change nothing).

## Open Questions

- `create_spendable_outputs_psbt` may itself reject dust-level outputs
  (LDK checks the net output against the dust limit); may need a
  minimal/zero feerate at creation time with BDK paying the real fee, or an
  upstream API. Verify against LDK 0.2.x behavior before committing to the
  design.
- Fee math must use the returned expected-max-weight plus BDK's input weights.
- Decide the threshold where subsidizing is worth it (don't spend 2,000 sats
  of on-chain fees to rescue 800 sats of dust unless the user opts in).

## Context

- Origin: 2026-07-21 log review — 6 descriptors stuck failing every sweep
  pass, joined by a 7th from a Megalith LSP force-close.
- Interim behavior (banner + periodic all-at-once retry) shipped in the
  `fix/sweep-pending-retry-banner` branch.
