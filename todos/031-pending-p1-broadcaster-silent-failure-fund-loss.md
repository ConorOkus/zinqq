---
status: complete
priority: p1
issue_id: "031"
tags: [code-review, security, fund-safety]
dependencies: []
---

# Broadcaster silently swallows failed transaction broadcasts

## Problem Statement

`src/ldk/traits/broadcaster.ts` fires HTTP POSTs to Esplora with only `console.error` on failure. If the transaction is a justice transaction (penalty for cheating counterparty) or a commitment transaction during force-close, silent failure means funds can be stolen. This is the same fire-and-forget anti-pattern that was fixed in the Persist trait (todo 017).

Note: Previously tracked as todo 014 (P3), but escalated to P1 after security analysis — justice/commitment tx broadcast failure is a direct fund-loss vector.

## Findings

- **Source:** Security Sentinel (re-review), escalated from todo 014
- **Location:** `src/ldk/traits/broadcaster.ts` lines 9-28
- **Evidence:** `.catch((err) => { console.error(...) })` with no retry

## Proposed Solutions

### Option A: Add retry logic similar to persistWithRetry
- Retry 3-5x with backoff for failed broadcasts
- Add onBroadcastFailure callback for error reporting
- Consider re-queuing failed broadcasts on the sync loop
- **Effort:** Small-Medium

## Acceptance Criteria

- [ ] Failed broadcasts are retried with backoff
- [ ] Exhausted retries surface an error (not just console.error)
- [ ] Justice/commitment transactions are not silently lost

## Work Log

| Date | Action | Details |
|------|--------|---------|
| 2026-03-11 | Created | From PR #3 re-review, escalated from todo 014 |
