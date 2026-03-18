---
status: complete
priority: p2
issue_id: "084"
tags: [code-review, ux, quality]
dependencies: []
---

# Replace alert('Coming soon') with non-blocking feedback

## Problem Statement

The scan QR button in `TabBar.tsx` uses `window.alert()`, which is a synchronous blocking call. In a wallet app, blocking the main thread is undesirable.

## Findings

- **File:** `src/components/TabBar.tsx`, scan button onClick
- **Identified by:** security-sentinel (LOW-2)

## Acceptance Criteria

- [ ] Replace `alert()` with a visual disabled state, tooltip, or brief toast notification
