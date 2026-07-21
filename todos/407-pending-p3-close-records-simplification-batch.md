---
status: pending
priority: p3
issue_id: '407'
tags: [code-review, close-records, simplification, quality, pr-172]
dependencies: []
---

# Close-records simplification batch (~220 LOC of padding; hard parts stay)

## Problem Statement

The implementation carries ~14% removable padding around a justified core. The reviewers
explicitly fenced off the load-bearing complexity (merge semantics, tolerant decode +
extras, VSS fetch-merge-rewrite, sync read model, reconcile guards) — do NOT simplify
those.

## Findings (each independently applicable)

1. Dead code: `closeRecordsInitialized()` + `initialized` flag (`store.ts`), unused
   `CloseLifecycleCallback` type (`signals.ts:32`), unreachable try/catch around
   `initCloseRecords` (`init.ts:740-744` — `enqueue` swallows all errors).
2. Wire-or-drop: `outpoints`/`valueSats` capture chain (`event-handler.ts:433-440`,
   `readDescriptorValueSats`, `sweep.ts` plumbing) has no consumer — but todo 402 Option B
   would consume it. Decide together. Keep `channelIdHex` + legacy-entry compat regardless.
3. `classifyClosureReason` if-chain → `[ctor, classification]` table (~90 LOC saved;
   exhaustiveness test unchanged).
4. Activity.tsx two-branch row duplication → one JSX block with computed variants.
5. ChannelCloseDetail hand-rolled recovery subscription duplicates `useRecovery()`
   (incl. re-hardcoding the event name) → use the hook.
6. Reconcile completion: three near-identical upserts → one write with a
   verified/unverified predicate (keep every predicate + comment).
7. Minor: double `if (result.swept > 0)` (context.tsx:1360); double
   `channel_funding_txo` getter read (event-handler.ts:375-379, also flagged as WASM-wrapper
   churn); double `toBigIntOrUndefined` call (close-record.ts:191); `vssVersionRef` object →
   plain let; init's double-serialize comparison → always write; merge identical
   onchain/lightning union arms; skeleton-record factory (optional); `spend.txid!` → local
   const; extras merge direction (base-wins contradicts doc — prefer incoming);
   broadcast sentinel strings → exported constants; `notifyChanged()` in upsert's sync path;
   round-robin start index for reconcile's query budget (plan specified; starvation only
   with >8 pending closes); `recordFundingTxo` sync-map asymmetry vs store doctrine;
   `event-handler.test.ts` should reset close-records store state between tests;
   verify recovery UI copy when `localBalanceSat: 0` (record-miss degraded signal).

## Proposed Solutions

### Option A: One cleanup PR applying items 1, 3-7 (+ item 2 per todo 402's decision)

Effort: Medium (mechanical). Risk: low — behavior-preserving, tests exist.

## Recommended Action

(Triage)

## Acceptance Criteria

- [ ] No dead exports/types remain in close-records
- [ ] Item 2 resolved explicitly (wired to measurement or dropped)
- [ ] All 575+ tests still pass

## Work Log

- 2026-07-21: Filed from /ce:review of PR #172 (code-simplicity-reviewer + convergent
  minors from kieran-typescript-reviewer/architecture-strategist/security-sentinel).
