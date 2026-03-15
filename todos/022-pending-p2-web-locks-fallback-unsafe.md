---
status: complete
priority: p2
issue_id: "022"
tags: [code-review, security, fund-safety]
dependencies: []
---

# Web Locks fallback silently disables multi-tab protection

## Problem Statement

If the Web Locks API is unavailable, `acquireWalletLock()` logs a warning and continues. Two tabs with independent ChannelManagers would broadcast conflicting commitment transactions — a fund-loss scenario.

## Findings

- **Source:** Security Sentinel (M1)
- **Location:** `src/ldk/init.ts` lines 65-67
- **Evidence:** `console.warn('...skipping multi-tab guard'); return`

## Proposed Solutions

### Option A: Fail initialization if Web Locks unavailable
- Throw an error explaining the browser doesn't support required security features
- **Effort:** Small

## Acceptance Criteria

- [ ] Missing Web Locks API causes initialization to fail with descriptive error
- [ ] Error surfaced to UI

## Work Log

| Date | Action | Details |
|------|--------|---------|
| 2026-03-11 | Created | From PR #3 code review |
