---
status: pending
priority: p2
issue_id: '203'
tags: [code-review, quality, recovery]
dependencies: []
---

# Fix mutable state patterns and race hazard in recovery

## Problem Statement

Two mutable state patterns in the recovery flow create data integrity risks under concurrent force-close scenarios.

## Findings

**1. Direct mutation in `enterRecovery` (use-recovery.ts:52-57)**
The `existing` object from `readRecoveryState()` is mutated in place (`push`, `+=`). If `readRecoveryState` is ever cached or memoized, this becomes a shared-mutation bug.

**2. `lastForceCloseInfo` module-level variable (event-handler.ts:678)**
Set in `ChannelClosed`, consumed in `BumpTransaction`. If two channels force-close in quick succession, only the last one's info survives — recovery callback reports wrong channel ID and balance.

**Sources:** kieran-typescript-reviewer (#1, #5), security-sentinel (#1), code-simplicity-reviewer

## Proposed Solutions

### Option A: Spread + Map (Recommended)

- Spread `existing` to a new object in `enterRecovery` instead of mutating
- Replace `lastForceCloseInfo` with a `Map<string, { channelId: string; localBalanceSat: number }>` keyed by channel ID
- **Effort:** Small | **Risk:** Low

## Acceptance Criteria

- [ ] `enterRecovery` creates new object via spread, never mutates input
- [ ] `lastForceCloseInfo` replaced with Map, BumpTransaction looks up by channel ID
- [ ] No module-level mutable variables that can be overwritten by concurrent events

## Work Log

| Date       | Action                           | Learnings                            |
| ---------- | -------------------------------- | ------------------------------------ |
| 2026-04-14 | Created from PR #128 code review | Multiple agents flagged same pattern |

## Resources

- PR: #128
- Files: `src/ldk/recovery/use-recovery.ts:52-57`, `src/ldk/traits/event-handler.ts:678`
