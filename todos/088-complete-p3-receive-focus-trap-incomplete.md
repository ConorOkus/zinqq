---
status: complete
priority: p3
issue_id: "088"
tags: [code-review, accessibility]
dependencies: []
---

# Complete focus trap in Receive overlay

## Problem Statement

The Receive overlay auto-focuses the first focusable element on mount, but does not trap Tab cycling — keyboard users can Tab behind the overlay. For a true focus trap, consider `focus-trap-react` or keyboard event listeners.

## Findings

- **File:** `src/pages/Receive.tsx`, useEffect focus management
- **Identified by:** kieran-typescript-reviewer (Medium-6)

## Acceptance Criteria

- [ ] Implement proper focus trap (Tab cycles within overlay, Shift+Tab wraps around)
- [ ] Return focus to the REQUEST button on dismiss
