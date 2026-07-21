---
date: 2026-07-21
topic: channel-close-transparency
---

# Channel Close Transparency (Coop + Force Close)

## What We're Building

Make both cooperative and force-close flows legible end-to-end. Today `CloseChannel.tsx` confirms a close with no fee estimate, the success screen shows no closing txid or explorer link, and once the channel disappears there is no record of what happened — the only surviving surface is the recovery banner when a sweep gets stuck.

We will add:

1. **Pre-close clarity** — the confirm screen shows estimated on-chain cost, expected timeline (coop: ~minutes once confirmed; force: timelock up to ~14 days), the amount expected back, and plain-language explanation of coop vs force close.
2. **Persistent close records** — a per-close record created at `Event_ChannelClosed`, updated as the commitment tx, anchor fee-bump (CPFP), and sweep transactions broadcast and confirm. Persisted IDB + VSS, following the existing recovery-state pattern, so tracking survives restarts and cross-device restore.
3. **Grouped history item** — each close appears in transaction history as one "Channel close" entry with a stage status (pending → timelock → swept/complete), expandable to show each underlying transaction with txid, mempool.space link, fee paid, and confirmations. Total cost of the close is summarized once complete.

### What each close type looks like

- **Cooperative close**: confirm screen shows estimated closing fee and "~minutes once confirmed"; record tracks one mutual closing transaction paying directly to the on-chain wallet; history entry completes when it confirms.
- **Force close (user- or counterparty-initiated, incl. HTLC timeout)**: confirm screen shows the timelock warning (up to ~14 days) and a labeled rough total-cost estimate; record tracks commitment tx → optional anchor fee-bump (CPFP) → sweep, with a "needs deposit" stage linking to `/recover` if the fee-bump is blocked on missing UTXOs.

## Why This Approach

Three approaches were considered:

- **A. Persistent close records (chosen)** — new persisted record per close; only option whose grouping survives restarts.
- **B. Derived, no persistence** — in-memory txid tagging matched against BDK's tx list; rejected because force closes span days and the grouping would be lost on any restart mid-close.
- **C. Screen polish only** — rejected as it delivers none of the pending-tracking or historical record.

Force closes are exactly the situation where the app will be closed and reopened many times, so restart-surviving state is a requirement, not a nice-to-have.

## Key Decisions

- **Tracking lives in transaction history**, not a dedicated status page: closes are history items with expandable detail. Lighter weight; no new top-level surface.
- **One grouped item per close**, not separate entries per tx: a single "Channel close" entry expands to show commitment / fee-bump / sweep transactions individually.
- **Persist close records IDB + VSS** (recovery-state pattern): dual-write with conflict retry, so records restore across devices.
- **Education is inline**: coop-vs-force explanation and timeline expectations live in the close confirm flow, not a separate help section.
- **Covers all close paths**: user-initiated coop, user-initiated force, and remote/automatic closes (counterparty force close, HTLC timeout) all produce records — the event handler already classifies these via `isForceClose()`.

## Resolved Questions

- **Blocked sweeps link into `/recover`**: when a sweep is stuck on missing UTXOs, the close record shows a "needs deposit" stage linking to the existing RecoverFunds page. The recovery banner stays as-is; one source of truth for the fix-it flow.
- **No backfill**: only closes after the feature ships get records. Past closes lack the event-time data (reason, balances, txids) needed for an accurate record.
- **Labeled rough estimate for force-close cost**: the confirm screen shows a single estimated total at current feerates, clearly labeled as an estimate that varies with network conditions — no itemized breakdown or range.

## Next Steps

→ `/ce:plan` for implementation details
