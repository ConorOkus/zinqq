---
status: complete
priority: p1
issue_id: '197'
tags: [code-review, bug, receive]
---

# Reset activeQrPage when BOLT 12 page disappears

## Problem Statement

When `showBolt12` transitions from `true` to `false` (e.g., channels become unusable), the second QR page disappears but `activeQrPage` can remain `'bolt12'`. This causes `copyValue` to use `bolt12Uri` while the visible QR shows the unified page — a state desync bug.

## Findings

- `activeQrPage` is only updated by the scroll handler, not when the BOLT 12 page is removed from the DOM
- If the user is on the BOLT 12 page and `needsAmount` becomes true, the pager collapses to one page but copy/share still reference the BOLT 12 offer
- Flagged independently by 3 review agents (TypeScript, Architecture, Agent-native)

## Proposed Solutions

### Solution 1: Add reset effect (Recommended)

Add `useEffect(() => { if (!showBolt12) setActiveQrPage('unified') }, [showBolt12])` to Receive.tsx.

- **Pros**: Simple, direct, covers all cases
- **Cons**: None
- **Effort**: Small (1 line)

## Acceptance Criteria

- [ ] When BOLT 12 page disappears, `activeQrPage` resets to `'unified'`
- [ ] Copy/share always matches the visible QR content
