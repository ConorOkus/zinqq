---
status: complete
priority: p2
issue_id: "021"
tags: [code-review, reliability, architecture]
dependencies: []
---

# Sync loop has no error backoff and never updates syncStatus

## Problem Statement

If `syncOnce` throws (Esplora down, rate limited), the error is logged and the next tick is scheduled at the same interval with no backoff. The wallet silently falls behind the chain — force-close deadlines, HTLC timeouts, and penalty transactions could all be missed. Additionally, `syncStatus` is set to `'syncing'` at initialization but never transitions to `'synced'` or `'stale'`, so the UI cannot reflect the actual sync state.

## Findings

- **Source:** Security Sentinel (H3), Architecture Strategist, TypeScript Reviewer, Simplicity Reviewer
- **Location:** `src/ldk/sync/chain-sync.ts` lines 108-114, `src/ldk/context.tsx` line 42
- **Evidence:** `catch (err) { console.error(...) }` with no backoff; `syncStatus: 'syncing'` hardcoded

## Proposed Solutions

### Option A: Backoff + status callback
- Track consecutive error count, double interval on error (cap at 5 min), reset on success
- Add `onSyncStatus` callback to `startSyncLoop` for status transitions
- Wire callback to React context setState
- **Effort:** Small-Medium

## Acceptance Criteria

- [ ] Consecutive sync errors trigger exponential backoff (capped)
- [ ] Successful sync resets to base interval
- [ ] syncStatus transitions: 'syncing' → 'synced' on success, → 'stale' after N failures
- [ ] Status observable by both React context and programmatic consumers

## Work Log

| Date | Action | Details |
|------|--------|---------|
| 2026-03-11 | Created | From PR #3 code review |
