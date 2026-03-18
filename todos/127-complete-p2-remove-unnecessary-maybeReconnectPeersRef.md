---
status: pending
priority: p2
issue_id: 127
tags: [code-review, simplicity]
dependencies: []
---

# Remove unnecessary maybeReconnectPeersRef

## Problem Statement

`maybeReconnectPeersRef` is used to share the `maybeReconnectPeers` function from inside the useEffect closure to the visibility handler. But the visibility handler is defined inside the same useEffect closure — both functions share the same scope. The ref is unnecessary indirection.

## Findings

- **Simplicity Reviewer**: The visibility handler can call `maybeReconnectPeers()` directly since both are in the same useEffect.

## Proposed Solutions

Remove `maybeReconnectPeersRef` declaration, assignment, and usage. Replace `maybeReconnectPeersRef.current?.()` with direct `maybeReconnectPeers()` call.

- **Effort**: Small (3 lines removed)
- **Risk**: Low

## Technical Details

**Affected files:** `src/ldk/context.tsx` (lines 43, 531, 725)

## Acceptance Criteria

- [ ] `maybeReconnectPeersRef` removed entirely
- [ ] Visibility handler calls `maybeReconnectPeers()` directly
- [ ] Reconnection still works after tab backgrounding
