---
status: pending
priority: p3
issue_id: 129
tags: [code-review, type-safety]
dependencies: []
---

# Fix checkReceivability returning misleading reason when node is null

## Problem Statement

`checkReceivability()` returns `{ canReceive: false, reason: 'no-channels' }` when `nodeRef.current` is null. This conflates "node not initialized" with "no channels." Since `checkReceivability` is only exposed in the `ready` state (where node exists), this path should be unreachable — but the misleading return is a code smell.

## Proposed Solutions

Either throw an error (since the path is unreachable) or add a `'not-ready'` reason to the union.

- **Effort**: Small
- **Risk**: Low

## Technical Details

**Affected files:** `src/ldk/context.tsx` (line 172), `src/ldk/ldk-context.ts`
