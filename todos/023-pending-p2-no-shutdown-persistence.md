---
status: complete
priority: p2
issue_id: "023"
tags: [code-review, reliability, fund-safety]
dependencies: []
---

# No persistence on shutdown or tab close

## Problem Statement

The sync loop persists ChannelManager only during tick intervals (~30s) and NetworkGraph/Scorer every ~5 min. The `stop()` method and React cleanup do not trigger a final persistence. If the user closes the tab between ticks, pending state changes are lost. No `beforeunload` handler exists.

## Findings

- **Source:** Security Sentinel (M2, M3), Architecture Strategist
- **Location:** `src/ldk/sync/chain-sync.ts` `stop()`, `src/ldk/context.tsx` cleanup
- **Evidence:** `stop()` only sets `stopped = true` and clears timeout — no final persist

## Proposed Solutions

### Option A: Add shutdown persistence + beforeunload handler
- Add final ChannelManager/NetworkGraph/Scorer persist in `stop()`
- Register `beforeunload` handler to trigger final persist
- **Effort:** Small

## Acceptance Criteria

- [ ] `stop()` persists ChannelManager, NetworkGraph, and Scorer before stopping
- [ ] `beforeunload` handler triggers final persistence attempt
- [ ] React useEffect cleanup calls stop() (already done)

## Work Log

| Date | Action | Details |
|------|--------|---------|
| 2026-03-11 | Created | From PR #3 code review |
