---
status: pending
priority: p3
issue_id: '097'
tags: [code-review, quality, performance]
dependencies: []
---

# Post-sync tip verification does nothing actionable

## Problem Statement

Step 6 of `syncOnce` fetches the tip hash again after sync completes. If it changed, it logs a warning but takes no action. The next scheduled tick handles it naturally. This is a wasted HTTP round-trip every sync cycle.

## Findings

- **File**: `src/ldk/sync/chain-sync.ts:121-125`
- **Identified by**: code-simplicity-reviewer

## Proposed Solution

Remove the post-sync tip check (lines 121-125). The sync loop timer will catch any tip change on the next tick. Saves one HTTP request per sync cycle.
