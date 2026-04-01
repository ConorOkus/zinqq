---
status: complete
priority: p2
issue_id: '200'
tags: [code-review, bug, receive]
---

# Guard handleScroll against zero clientWidth

## Problem Statement

In `Receive.tsx`, the `handleScroll` callback divides by `el.clientWidth`:

```typescript
const page = Math.round(el.scrollLeft / el.clientWidth)
```

If `clientWidth` is 0 (element not yet laid out, display:none), this produces `NaN` or `Infinity`, causing `setActiveQrPage` to receive an unexpected value.

## Proposed Solutions

### Solution 1: Add guard (Recommended)

```typescript
if (!el || el.clientWidth === 0) return
```

- **Effort**: Small (1 line)

## Acceptance Criteria

- [ ] `handleScroll` returns early when `clientWidth` is 0
