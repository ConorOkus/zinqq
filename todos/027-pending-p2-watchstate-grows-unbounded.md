---
status: complete
priority: p2
issue_id: "027"
tags: [code-review, performance, architecture]
dependencies: []
---

# WatchState maps grow unboundedly — no cleanup after confirmation

## Problem Statement

`watchedTxids` and `watchedOutputs` in the Filter trait's WatchState are append-only. Entries are never removed after transactions are confirmed or outputs are spent. Over the wallet's lifetime, each sync tick re-checks every historical item against Esplora, causing O(n) HTTP requests per tick.

## Findings

- **Source:** TypeScript Reviewer, Architecture Strategist, Simplicity Reviewer
- **Location:** `src/ldk/traits/filter.ts`, `src/ldk/sync/chain-sync.ts`

## Proposed Solutions

### Option A: Remove confirmed/spent entries after processing in syncOnce
- After calling `transactions_confirmed`, remove the txid from `watchedTxids`
- After confirming an output spend, remove from `watchedOutputs`
- **Effort:** Small

## Acceptance Criteria

- [ ] Confirmed transactions removed from watchedTxids after processing
- [ ] Spent outputs removed from watchedOutputs after processing
- [ ] New registrations from Filter still accumulate normally

## Work Log

| Date | Action | Details |
|------|--------|---------|
| 2026-03-11 | Created | From PR #3 code review |
