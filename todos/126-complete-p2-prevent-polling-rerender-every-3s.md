---
status: pending
priority: p2
issue_id: 126
tags: [code-review, performance, react]
dependencies: []
---

# Prevent unnecessary re-renders from receivability polling

## Problem Statement

The Receive page polls `checkReceivability()` every 3 seconds and calls `setReceivability(status)` with a new object reference each time. React re-renders the component on every call because the object reference changes, even when the status is identical (same `canReceive` value and `reason`).

## Findings

- **TypeScript Reviewer**: Identified that `setReceivability` creates a new object each poll, causing re-render every 3s even when nothing changed.

## Proposed Solutions

### Option A: Functional state update with reference equality (Recommended)
Use `setReceivability(prev => ...)` and return `prev` when status is identical.

- **Effort**: Small (5 lines)
- **Risk**: Low

## Technical Details

**Affected files:** `src/pages/Receive.tsx` (poll function, ~line 39)

## Acceptance Criteria

- [ ] `setReceivability` only triggers re-render when status actually changes
- [ ] Stale invoice warning still works when status transitions
