---
status: complete
priority: p1
issue_id: "050"
tags: [code-review, security, fund-safety]
dependencies: []
---

# Broadcast failure permanently loses signed funding transaction

## Problem Statement

In `FundingTxBroadcastSafe`, the cache entry is deleted **before** the broadcast succeeds. If the Esplora endpoint is unreachable (network blip, rate limit, DNS failure), the signed funding transaction is lost forever. LDK has already accepted the funding transaction, so the channel is stuck in a pending state and the user's funds are locked.

## Findings

- **Source**: security-sentinel, architecture-strategist
- **File**: `src/ldk/traits/event-handler.ts:277-286`
- Line 278: `fundingTxCache.delete(tempChannelIdHex)` runs before broadcast succeeds
- The `.catch()` handler only logs — no retry, no re-caching
- The existing `broadcaster.ts` has the same fire-and-forget pattern but is called by LDK internally with retries; this manual broadcast has no retry

## Proposed Solutions

### Option A: Move cache delete into success callback
- Move `fundingTxCache.delete()` into the `.then()` callback so the entry survives broadcast failure
- **Pros**: Simple 1-line move, preserves retry capability
- **Cons**: Cache entry leaks if broadcast never succeeds (mitigated by tab refresh)
- **Effort**: Small
- **Risk**: Low

### Option B: Add retry with exponential backoff
- Implement 3 retries with backoff (1s, 3s, 10s) before giving up
- **Pros**: Handles transient network issues
- **Cons**: More code in a temporary module
- **Effort**: Medium
- **Risk**: Low

## Recommended Action

Option A is the minimum fix — move the delete. Option B is ideal but may be over-engineering for temporary signet code.

## Technical Details

**Affected files**: `src/ldk/traits/event-handler.ts`

## Acceptance Criteria

- [ ] Cache entry is NOT deleted until broadcast succeeds
- [ ] Failed broadcast leaves the tx in cache for potential manual recovery
- [ ] Test verifies cache is retained on broadcast failure

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-12 | Identified during PR #8 code review | Fund-safety critical path |

## Resources

- PR: #8
- Institutional learning: `docs/solutions/integration-issues/ldk-event-handler-patterns.md`
