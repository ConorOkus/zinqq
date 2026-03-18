---
status: complete
priority: p3
issue_id: "087"
tags: [code-review, quality, duplication]
dependencies: []
---

# Extract duplicated SVG icons into shared icons module

## Problem Statement

~23 inline SVGs scattered across 9 files, with at least 4 icons duplicated 2+ times (send arrow, receive arrow, next arrow, close X). A shared `src/components/icons.tsx` would eliminate ~80-100 lines of duplication.

## Findings

- **Files:** Home.tsx, Activity.tsx, TabBar.tsx, Numpad.tsx, Send.tsx, ScreenHeader.tsx, BalanceDisplay.tsx, Settings.tsx, Advanced.tsx
- **Identified by:** kieran-typescript-reviewer (Medium-8), code-simplicity-reviewer (Finding-2), architecture-strategist (Section 3.5)

## Acceptance Criteria

- [ ] Create `src/components/icons.tsx` with named exports (ArrowUpRight, ArrowDownLeft, ChevronBack, XClose, Check, Eye, EyeOff, etc.)
- [ ] Replace inline SVGs with icon component imports across all affected files
