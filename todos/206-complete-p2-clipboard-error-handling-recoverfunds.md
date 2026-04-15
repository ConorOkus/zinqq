---
status: pending
priority: p2
issue_id: '206'
tags: [code-review, quality, recovery]
dependencies: []
---

# Add clipboard error handling in RecoverFunds

## Problem Statement

`navigator.clipboard.writeText` in `RecoverFunds.tsx:27` can throw (permissions denied, non-secure context). No try/catch exists, so clipboard failure produces an unhandled promise rejection and the "Copied!" feedback never appears. The Receive page handles this correctly.

## Findings

**Source:** security-sentinel (#5)

Compare with `src/pages/Receive.tsx:239` which wraps clipboard in try/catch.

## Proposed Solutions

### Option A: Wrap in try/catch (Recommended)

- Add try/catch to `copyAddress` callback
- Show error state or silently fail (consistent with Receive pattern)
- **Effort:** Small | **Risk:** Low

## Acceptance Criteria

- [ ] `copyAddress` in RecoverFunds has try/catch around clipboard write
- [ ] Consistent with error handling pattern in Receive.tsx

## Work Log

| Date       | Action                           | Learnings |
| ---------- | -------------------------------- | --------- |
| 2026-04-14 | Created from PR #128 code review |           |

## Resources

- PR: #128
- Files: `src/pages/RecoverFunds.tsx:27`, `src/pages/Receive.tsx:239` (pattern reference)
