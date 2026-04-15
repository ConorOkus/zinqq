---
status: complete
priority: p3
issue_id: '140'
tags: [code-review, testing]
---

# Extract readyLdkContext test helper to reduce duplication

## Problem Statement

The "exceeds lightning capacity" test duplicates the entire 28-line LDK context mock inline, only differing in `outboundCapacityMsat` and `lightningBalanceSats`. This should use a helper matching the `readyContext` pattern for onchain.

## Findings

- Flagged by TypeScript reviewer, Simplicity reviewer
- `src/pages/Send.test.tsx` lines 436-463 duplicates lines 54-81

## Proposed Solutions

Extract `readyLdkContext(overrides)` helper function.

- Effort: Small
- Risk: None
