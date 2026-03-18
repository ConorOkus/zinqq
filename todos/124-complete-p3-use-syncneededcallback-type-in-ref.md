---
status: pending
priority: p3
issue_id: 124
tags: [code-review, quality, typescript]
dependencies: []
---

# Use SyncNeededCallback type alias in OnchainProvider ref

## Problem Statement

In `src/onchain/context.tsx` line 92, the ref type uses an inline `(() => void) | undefined` instead of importing and using the `SyncNeededCallback` type alias. This creates type drift risk if the callback signature ever changes.

## Findings

- **TypeScript reviewer**: "Inline `(() => void) | undefined` duplicates the SyncNeededCallback type — import it for consistency"

## Proposed Solutions

### Option A: Import and use SyncNeededCallback
- `import type { SyncNeededCallback } from '../ldk/traits/event-handler'`
- Change ref type to use `SyncNeededCallback | undefined`
- **Effort**: Small (2 lines)

## Technical Details

- **File**: `src/onchain/context.tsx` line 92

## Acceptance Criteria

- [ ] Ref type uses imported `SyncNeededCallback` instead of inline function type

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-17 | Created from PR #30 code review | |

## Resources

- PR: #30
