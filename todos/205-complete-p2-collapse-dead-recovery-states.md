---
status: pending
priority: p2
issue_id: '205'
tags: [code-review, simplicity, recovery]
dependencies: []
---

# Collapse dead states and remove unused types from recovery

## Problem Statement

The 4-state recovery state machine has 2 states with no behavioral impact, and the `SweepFailureReason` type is never read by any consumer. This is speculative complexity that should be removed.

## Findings

**1. `deposit_shown` state — no behavioral impact (use-recovery.ts:16)**
Written when user opens RecoverFunds, but never read for branching. Banner doesn't distinguish it from `needs_recovery`.

**2. `deposit_detected` state — dead code (RecoveryBanner.tsx:47)**
Only consumed in banner subtitle text, but nothing ever transitions to this status. No code writes `deposit_detected`.

**3. `SweepFailureReason` and `failureReason` field — YAGNI (sweep.ts:19-26)**
`no_utxos` variant is never assigned. No consumer reads `failureReason` — callers only check `result.swept > 0`.

**4. `refreshDepositNeeded` — premature (use-recovery.ts:115-124)**
Re-fetches fees and writes to IDB+VSS on every page open. Auto-recovery timer already retries with fresh fees.

**Source:** code-simplicity-reviewer

## Proposed Solutions

### Option A: Collapse to 2 states (Recommended)

- Remove `deposit_shown` and `deposit_detected` from `RecoveryStatus`
- Keep `needs_recovery` and `sweep_confirmed` only
- Remove `SweepFailureReason` type and `failureReason` field from `SweepResult`
- Remove `refreshDepositNeeded` from hook
- ~40-50 lines removable
- **Effort:** Small | **Risk:** Low

## Acceptance Criteria

- [ ] `RecoveryStatus` has exactly 2 values: `needs_recovery` and `sweep_confirmed`
- [ ] `SweepResult` has no `failureReason` field
- [ ] No `refreshDepositNeeded` method on the hook
- [ ] All tests still pass

## Work Log

| Date       | Action                           | Learnings                                                            |
| ---------- | -------------------------------- | -------------------------------------------------------------------- |
| 2026-04-14 | Created from PR #128 code review | State machine designed for future, but should match current behavior |

## Resources

- PR: #128
- Files: `src/ldk/recovery/recovery-state.ts`, `src/ldk/recovery/use-recovery.ts`, `src/ldk/sweep.ts`, `src/components/RecoveryBanner.tsx`
