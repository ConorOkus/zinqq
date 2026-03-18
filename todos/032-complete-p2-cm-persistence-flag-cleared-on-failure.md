---
status: complete
priority: p2
issue_id: "032"
tags: [code-review, security, reliability]
dependencies: []
---

# ChannelManager persistence clears dirty flag even when write fails

## Problem Statement

In the sync loop, `channelManager.get_and_clear_needs_persistence()` clears the internal flag when called. If the subsequent `idbPut` fails (caught by the generic error handler), the flag is already cleared. Next tick, `get_and_clear_needs_persistence()` may return false, and the stale state persists. If the tab closes, ChannelManager restores from stale data.

## Findings

- **Source:** Security Sentinel (re-review)
- **Location:** `src/ldk/sync/chain-sync.ts` lines 114-116
- **Evidence:** `get_and_clear_needs_persistence()` clears flag, then `idbPut` can throw in the generic catch

## Proposed Solutions

### Option A: Track dirty flag externally
- Set a `needsPersist` boolean before calling `get_and_clear_needs_persistence()`
- Only clear it after successful `idbPut`
- **Effort:** Small

### Option B: Wrap CM persistence in try/catch with re-flag
- If `idbPut` fails, set a local `cmPersistPending = true` flag checked on next tick
- **Effort:** Small

## Acceptance Criteria

- [ ] Failed CM persistence does not lose the "needs persist" signal
- [ ] Next tick retries the persistence
- [ ] Successful persistence clears the retry flag

## Work Log

| Date | Action | Details |
|------|--------|---------|
| 2026-03-11 | Created | From PR #3 re-review |
