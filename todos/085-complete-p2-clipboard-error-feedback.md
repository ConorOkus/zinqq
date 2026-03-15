---
status: complete
priority: p2
issue_id: "085"
tags: [code-review, ux, security]
dependencies: []
---

# Show feedback when clipboard copy fails in Receive

## Problem Statement

The clipboard write in `Receive.tsx` silently swallows errors. Since this is a Bitcoin address that must be transmitted accurately, the user should know when copy fails.

## Findings

- **File:** `src/pages/Receive.tsx`, `handleCopy` catch block
- **Identified by:** security-sentinel (LOW-3)

## Acceptance Criteria

- [ ] Set an error state in the catch block
- [ ] Display "Copy failed — select and copy manually" or similar feedback
