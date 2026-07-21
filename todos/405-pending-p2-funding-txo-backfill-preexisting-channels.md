---
status: pending
priority: p2
issue_id: '405'
tags: [code-review, close-records, reconcile, pr-172]
dependencies: []
---

# Funding-txo safety net only covers channels opened after deploy

## Problem Statement

`recordFundingTxo` is called only from `Event_ChannelPending`, so channels already open
when this ships never enter the safety-net map. A crash between the event handler's ok()
and the record persist during THEIR close produces no record, and reconciliation's
vanished-channel diff has nothing to heal from. The plan specified the map be "updated on
channel open/sync".

## Findings

- architecture-strategist P2 #4: `src/ldk/traits/event-handler.ts:339-350` (only writer),
  `src/ldk/close-records/reconcile.ts:111-134` (the diff that would miss).
- `ChannelDetails.get_funding_txo()` is available from `list_channels()` on the sync tick.

## Proposed Solutions

### Option A: Backfill from `list_channels()` inside reconcile (or onSynced)

For each open channel absent from the map, record its funding txo. Cheap set-difference per
new-tip tick; could also capture `to_self_delay` for todo 397 Option A in the same pass.
Effort: Small. Risk: none.

## Recommended Action

(Triage — consider pairing with todo 397 Option A.)

## Technical Details

- **Affected files**: `src/ldk/close-records/reconcile.ts` (or a small backfill helper),
  `reconcile.test.ts`.

## Acceptance Criteria

- [ ] Channels open before deploy appear in the funding-txo map after one sync tick
- [ ] Vanished-channel record creation works for pre-deploy channels

## Work Log

- 2026-07-21: Filed from /ce:review of PR #172 (architecture-strategist).
