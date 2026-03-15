---
status: complete
priority: p1
issue_id: "017"
tags: [code-review, security, fund-safety]
dependencies: []
---

# Silent persist failure allows potential fund loss

## Problem Statement

In `src/ldk/traits/persist.ts`, both `persist_new_channel` and `update_persisted_channel` return `InProgress` and fire async IndexedDB writes. If the write fails, the `.catch()` only logs to `console.error` — it never calls `chainMonitor.channel_monitor_updated()`. This means LDK waits forever for a completion signal that never arrives. The channel continues operating under the assumption its state is persisted, but on force-close the stale state could enable the counterparty to claim funds using a revoked commitment.

## Findings

- **Source:** Security Sentinel (C1), Architecture Strategist
- **Location:** `src/ldk/traits/persist.ts` lines 37-45 and 60-68
- **Evidence:** The `.catch()` block only calls `console.error` — no retry, no force-close, no `channel_monitor_updated` with error
- **Failure scenarios:** IndexedDB quota full, browser throttling IDB in background tab, database corruption

## Proposed Solutions

### Option A: Retry with force-close fallback
- Retry IndexedDB write 3x with exponential backoff
- On final failure, broadcast latest holder commitment transaction to force-close
- **Pros:** Maximizes chance of persistence success, safe fallback
- **Cons:** More complex, force-close is disruptive
- **Effort:** Medium
- **Risk:** Low

### Option B: Retry and halt channel operations
- Retry 3x with backoff
- On failure, do NOT call `channel_monitor_updated` (LDK halts channel ops — safe but disruptive)
- Surface error to UI via callback
- **Pros:** Simpler, LDK's built-in safety handles the rest
- **Cons:** Channel is stuck until page reload
- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] Persist failures trigger retry (at least 3 attempts)
- [ ] After exhausting retries, error is surfaced (not just console.error)
- [ ] `channel_monitor_updated` is NOT called on failure (LDK halts channel as safety measure)
- [ ] Error state is observable by UI/agents

## Work Log

| Date | Action | Details |
|------|--------|---------|
| 2026-03-11 | Created | From PR #3 code review |

## Resources

- PR: #3
- File: `src/ldk/traits/persist.ts`
- LDK docs: `channel_monitor_updated` must only be called after successful persistence
