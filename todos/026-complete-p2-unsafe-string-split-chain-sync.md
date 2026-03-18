---
status: complete
priority: p2
issue_id: "026"
tags: [code-review, quality, input-validation]
dependencies: []
---

# Unsafe string split on watched output key in chain-sync

## Problem Statement

`key.split(':')` destructuring in `syncOnce` is unsafe — if key has no colon, `voutStr` is `undefined` and `parseInt(undefined, 10)` returns `NaN`, silently passed to Esplora API.

## Findings

- **Source:** TypeScript Reviewer (P1-2), Security Sentinel (L4)
- **Location:** `src/ldk/sync/chain-sync.ts` line 78

## Proposed Solutions

### Option A: Read outpoint from WatchedOutput directly
- The WatchedOutput is already stored in the map value — use `output.get_outpoint()` instead of parsing the key
- **Effort:** Small

### Option B: Add guard on split result
- Validate the split produces two parts and parseInt is not NaN
- **Effort:** Small

## Acceptance Criteria

- [ ] Malformed output keys cannot produce NaN vout values
- [ ] Either use WatchedOutput's outpoint directly or validate the split

## Work Log

| Date | Action | Details |
|------|--------|---------|
| 2026-03-11 | Created | From PR #3 code review |
