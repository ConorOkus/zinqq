---
title: 'to_self_delay binds only the broadcaster — remote force closes leave our funds unencumbered'
category: logic-errors
date: 2026-07-21
tags: [lightning, timelock, csv, force-close, to-self-delay, close-records, domain-knowledge]
modules: [src/ldk/close-records/reconcile]
---

# to_self_delay binds only the broadcaster — remote force closes leave our funds unencumbered

## Problem

Close-record reconciliation derived a timelock expiry
(`claimableAtHeight = close confirm height + to_self_delay`) for **every** force close.
For counterparty-initiated force closes this is wrong: the UI showed a phantom
"Waiting (timelock)" badge and completion was delayed by up to `to_self_delay` (~days)
after the funds had already been swept and confirmed.

## Root Cause

Protocol misunderstanding: the CSV `to_self_delay` encumbers only the **broadcaster's**
`to_local` output of the commitment transaction (it exists so the counterparty can punish
a revoked broadcast). When the **counterparty** force-closes, our balance is the
`to_remote` output — a `StaticPaymentOutput` with no meaningful wait (1-CSV on anchor
channels). LDK's own `ChannelDetails.get_force_close_spend_delay()` docs state this: the
delay applies "if we force-close"; "if our counterparty force-closes... we do not have to
wait any time".

## Solution

`src/ldk/close-records/reconcile.ts` (b2): skip the timelock derivation when
`record.initiator === 'remote'` (in addition to coop closes). Records with unknown
initiator still derive conservatively — combined with the receipt-before-gate ordering
(see [reconcile-receipt-evidence-before-derived-gates](reconcile-receipt-evidence-before-derived-gates.md)),
a wrong conservative timelock can delay only the badge, never a wallet-verified completion.

## Prevention

When modeling close timelines, always ask **who broadcast the commitment**. The
asymmetry table:

| Scenario                  | Our funds wait                       |
| ------------------------- | ------------------------------------ |
| We force-close            | `to_self_delay` (their chosen value) |
| Counterparty force-closes | ~none (1-CSV anchor `to_remote`)     |
| Coop close                | none (direct to our shutdown script) |

Zeus's user copy captures it well: "the party initiating the force close will have to
wait… the other side can spend their funds immediately."
