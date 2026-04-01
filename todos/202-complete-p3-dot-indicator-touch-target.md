---
status: complete
priority: p3
issue_id: '202'
tags: [code-review, accessibility, receive]
---

# Increase dot indicator touch target size

## Problem Statement

The dot indicator buttons on the QR pager are `h-2 w-2` (8x8 CSS pixels). This fails WCAG touch target guidelines (minimum 44x44px). Users may struggle to tap them on mobile.

## Proposed Solutions

### Solution 1: Add padding to increase hit area (Recommended)

Keep the visual dot small but add padding for a larger touch target:

```tsx
className = 'h-2 w-2 rounded-full ... p-3' // or use a wrapper with min-h-11 min-w-11
```

### Solution 2: Make dots non-interactive

Remove the `button` element and use `span` since swipe already handles page switching. Use `aria-hidden` since the dots are purely visual indicators.

- **Effort**: Small

## Acceptance Criteria

- [ ] Touch targets are at least 44x44px, or dots are non-interactive
