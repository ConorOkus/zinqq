---
status: complete
priority: p2
issue_id: "025"
tags: [code-review, performance]
dependencies: []
---

# Sequential HTTP calls in sync loop should be parallel

## Problem Statement

In `syncOnce`, watched txids and outputs are checked sequentially with `await` in a loop. For a wallet with multiple channels, this turns a 30s poll into multiple seconds of serial HTTP round-trips, meaning stale chain state for longer.

## Findings

- **Source:** TypeScript Reviewer (P1-3)
- **Location:** `src/ldk/sync/chain-sync.ts` steps 3 and 4 (watched txid and output loops)

## Proposed Solutions

### Option A: Use Promise.all for batched lookups
- Batch watched txid checks with `Promise.all`
- Batch watched output spend checks with `Promise.all`
- **Effort:** Small

## Acceptance Criteria

- [ ] Watched txid checks run in parallel
- [ ] Watched output checks run in parallel
- [ ] Error in one check doesn't block others (use Promise.allSettled if needed)

## Work Log

| Date | Action | Details |
|------|--------|---------|
| 2026-03-11 | Created | From PR #3 code review |
