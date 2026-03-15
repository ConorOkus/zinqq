---
status: pending
priority: p2
issue_id: "066"
tags: [code-review, quality]
dependencies: []
---

# canRetry is dead code and handleRetry is identical to handleBack

## Problem Statement

The `canRetry` field in the `SendStep` error variant is computed but never used to differentiate behavior. `handleRetry` and `handleBack` are identical functions — both reset to the input step. The comment on handleRetry says "Go back to review with the same values" but it does not do that.

## Findings

**Location:** `src/pages/Send.tsx`
- Line 19: `canRetry` in SendStep type definition
- Line 153: `canRetry` computed from error message
- Lines 158-165: handleBack and handleRetry are identical

Flagged by: code-simplicity-reviewer, architecture-strategist

## Proposed Solutions

### Option A: Remove canRetry and merge handlers (Recommended)
Remove `canRetry` from the type. Use a single handler for both "Back" and "Try Again" buttons.

- Effort: Small
- Risk: Low

## Acceptance Criteria

- [ ] canRetry removed from SendStep type
- [ ] Single handler used for back/retry navigation
- [ ] No misleading comments about retry-from-review
