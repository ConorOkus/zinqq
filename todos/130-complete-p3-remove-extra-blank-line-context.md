---
status: pending
priority: p3
issue_id: 130
tags: [code-review, quality]
dependencies: []
---

# Remove extra blank line in context.tsx

## Problem Statement

Spurious blank line at `src/ldk/context.tsx` line 405 between `outboundCapacityMsat` and the main `useEffect`.

## Proposed Solutions

Delete the blank line.

- **Effort**: Trivial
