---
status: complete
priority: p3
issue_id: '159'
tags: [code-review, quality]
dependencies: []
---

# Remove msatToSat alias — use msatToSatCeil directly

## Problem Statement

`const msatToSat = msatToSatCeil` in Send.tsx hides which rounding is used. Use `msatToSatCeil` directly at the 3 call sites for clarity.

**File:** `src/pages/Send.tsx` line 82

## Acceptance Criteria

- [ ] `msatToSat` alias removed
- [ ] All call sites use `msatToSatCeil` directly
