---
status: complete
priority: p3
issue_id: 123
tags: [code-review, testing, onchain]
dependencies: [122]
---

# Add test for syncNow() retry mechanics

## Problem Statement

The `syncNow()` retry behavior (3 retries at 3s intervals) has no test coverage. The plan called for `src/onchain/sync.test.ts` but it was not created. A test would have caught the `syncRequested` no-op bug (todo #122).

## Findings

- **TypeScript reviewer**: "No test for syncNow retry behavior — adding a test would have caught the syncRequested issue"

## Proposed Solutions

### Option A: Create src/onchain/sync.test.ts

- Test `syncNow()` triggers immediate tick
- Test retry logic (3 ticks at 3s intervals via fake timers)
- Test timer reset after retries complete
- **Effort**: Small

## Technical Details

- **File**: `src/onchain/sync.ts` (new test file: `src/onchain/sync.test.ts`)

## Acceptance Criteria

- [ ] Test verifies `syncNow()` fires immediate sync
- [ ] Test verifies 3 retries at 3s intervals
- [ ] Test verifies normal 30s interval resumes after retries

## Work Log

| Date       | Action                          | Learnings |
| ---------- | ------------------------------- | --------- |
| 2026-03-17 | Created from PR #30 code review |           |

## Resources

- PR: #30
