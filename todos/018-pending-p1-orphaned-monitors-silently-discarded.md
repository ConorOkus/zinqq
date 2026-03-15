---
status: complete
priority: p1
issue_id: "018"
tags: [code-review, security, fund-safety]
dependencies: []
---

# Orphaned ChannelMonitors silently discarded at startup

## Problem Statement

In `src/ldk/init.ts`, when ChannelManager bytes are missing from IndexedDB but ChannelMonitors exist, the code logs a warning and creates a fresh ChannelManager, discarding all existing monitors. These monitors represent open Lightning channels with real funds. Discarding them means the wallet loses the ability to enforce its side of existing channels.

## Findings

- **Source:** Security Sentinel (C2)
- **Location:** `src/ldk/init.ts` lines 153-157 (the `else` branch of CM restoration)
- **Evidence:** `console.warn('[LDK Init] Found orphaned ChannelMonitors without ChannelManager, starting fresh')`
- **Impact:** Counterparty can broadcast old commitment transactions with impunity

## Proposed Solutions

### Option A: Hard error — halt initialization
- Throw an error that surfaces in the React context as an error state
- Display a recovery-needed UI explaining the situation
- **Pros:** Safe, prevents silent fund loss
- **Cons:** User cannot use wallet until resolved
- **Effort:** Small
- **Risk:** Low

### Option B: Force-close all orphaned channels
- Use monitors' `get_latest_holder_commitment_txn()` to broadcast force-close transactions
- Then start fresh
- **Pros:** Recovers funds automatically
- **Cons:** More complex, requires broadcasting logic outside normal ChannelManager flow
- **Effort:** Large
- **Risk:** Medium

## Acceptance Criteria

- [ ] Orphaned monitors cause initialization to fail with a descriptive error (not a warning)
- [ ] Error state is surfaced to the UI
- [ ] No silent discarding of ChannelMonitor data

## Work Log

| Date | Action | Details |
|------|--------|---------|
| 2026-03-11 | Created | From PR #3 code review |

## Resources

- PR: #3
- File: `src/ldk/init.ts`
