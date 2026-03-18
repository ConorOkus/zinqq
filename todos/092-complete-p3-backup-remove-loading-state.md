---
status: complete
priority: p3
issue_id: "092"
tags: [code-review, simplicity, pr-14]
dependencies: []
---

# Remove YAGNI loading state from Backup page

## Problem Statement

The Backup page has a 4-variant discriminated union (`warning | loading | revealed | error`). The `loading` state exists to show a spinner while `getMnemonic()` resolves, but IndexedDB reads are sub-millisecond. The user will never see this state.

## Findings

- **Code Simplicity Reviewer (PR #14)**: The `loading` state is YAGNI — adds ~7 lines of unnecessary complexity for a local storage read that completes instantly.
- **Location**: `src/pages/Backup.tsx` lines 8, 15-16, 89-93

## Proposed Solutions

### Option A: Remove loading state (Recommended)
- Remove `{ status: 'loading' }` from the union
- Remove `setState({ status: 'loading' })` before the await
- Remove the loading render branch
- Go directly from `warning` to `revealed` or `error`
- **Pros**: Simpler code, fewer states to reason about
- **Cons**: None — IDB reads are instant
- **Effort**: Small (~7 lines removed)
- **Risk**: None

## Recommended Action

Option A

## Technical Details

- **Affected files**: `src/pages/Backup.tsx`

## Acceptance Criteria

- [ ] `BackupState` union has 3 variants: `warning | revealed | error`
- [ ] No loading spinner rendered
- [ ] Tests still pass

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-15 | Created from PR #14 review | IDB reads are sub-ms, loading state is YAGNI |

## Resources

- PR: #14
- Code Simplicity Reviewer finding
