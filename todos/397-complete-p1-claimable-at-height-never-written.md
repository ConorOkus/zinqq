---
status: complete
priority: p1
issue_id: '397'
tags: [code-review, close-records, reconcile, correctness, pr-172]
dependencies: []
---

# `claimableAtHeight` has no writer — timelock UI is dead and force closes can never reach "resolved (unverified)"

## Problem Statement

Grep confirms nothing ever sets `CloseRecord.claimableAtHeight`; it is only read. Three
plan-specified behaviors are dead code, one with a stuck-forever record state: (1)
`deriveCloseStatus` can never return `waiting_timelock`; (2) the ChannelCloseDetail
timelock countdown never renders; (3) the force-close arm of reconcile's
`resolved_unverified` terminal branch requires `claimableAtHeight !== undefined` and is
unreachable — a force close swept where this wallet can't see it stays "pending" forever
(coop closes have an escape; force closes don't). Found independently by
architecture-strategist, kieran-typescript-reviewer, and security-sentinel.

## Findings

- Readers: `src/ldk/close-records/close-record.ts:67-72` (status derivation),
  `src/pages/ChannelCloseDetail.tsx:143-146` (countdown), `src/ldk/close-records/reconcile.ts:226-228`
  (unverified gate). No writers anywhere.
- The plan's acceptance-criteria deviation notes cover monitor resolution status and
  auto-reopen — not this. It is the one genuinely silent drop.
- `to_self_delay` IS available pre-close: `estimate.ts` reads
  `ChannelDetails.get_force_close_spend_delay()`.

## Proposed Solutions

### Option A: Capture `to_self_delay` at `Event_ChannelPending`, derive height in reconcile

Store `timelockBlocks` alongside the funding txo (or on the record at close). Reconcile
sets `claimableAtHeight = commitmentTx.confirmedAtHeight + timelockBlocks` once the
commitment confirms. Restores all three behaviors. Effort: Medium. Risk: low.

### Option B: Relax the unverified gate only

Change `reconcile.ts:226-228` to allow force closes to reach `resolved_unverified` after a
conservative dwell (e.g. commitment final for ≥ 2016+6 blocks). Fixes the stuck state;
timelock UI stays dead (remove or comment those paths). Effort: Small. Risk: low.

## Recommended Action

Fixed: Option A + Option B dwell fallback (capture to_self_delay at ChannelPending into the safety-net map → record fact; reconcile derives claimableAtHeight from close confirm height + timelock; max-timelock dwell terminal for records without a captured timelock).

## Technical Details

- **Affected files**: `src/ldk/close-records/reconcile.ts`, `close-record.ts`,
  `signals.ts`/`store.ts` (if capturing delay), `src/pages/ChannelCloseDetail.tsx`.

## Acceptance Criteria

- [x] A force close with no wallet receipt reaches a terminal state in bounded time
- [x] Either `waiting_timelock`/countdown render with real data, or their dead code paths
      are removed/annotated
- [x] Reconcile test covering the force-close unverified path with the new gate

## Work Log

- 2026-07-21: Filed from /ce:review of PR #172 (3 agents converged).
- 2026-07-21: Fixed on feat/close-records-engine; tests added (580 total passing).
