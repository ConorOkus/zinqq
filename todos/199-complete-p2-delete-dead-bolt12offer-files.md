---
status: complete
priority: p2
issue_id: '199'
tags: [code-review, cleanup]
---

# Delete orphaned Bolt12Offer page and test files

## Problem Statement

The route and navigation link for the BOLT 12 Offer settings page were removed, but the component and test files still exist on disk as dead code. The test file still runs in CI, testing an unreachable component.

## Findings

- `src/pages/Bolt12Offer.tsx` — no longer imported or routed
- `src/pages/Bolt12Offer.test.tsx` — tests an unreachable component
- Flagged by 4 review agents

## Proposed Solutions

### Solution 1: Delete both files (Recommended)

Remove `src/pages/Bolt12Offer.tsx` and `src/pages/Bolt12Offer.test.tsx`.

- **Effort**: Small

## Acceptance Criteria

- [ ] Both files deleted
- [ ] All tests still pass
