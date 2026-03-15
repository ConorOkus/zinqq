---
status: complete
priority: p2
issue_id: "053"
tags: [code-review, simplicity, duplication]
dependencies: []
---

# Remove duplicate txBytesToHex — use existing bytesToHex

## Problem Statement

`txBytesToHex` in `tx-bridge.ts` is identical to `bytesToHex` in `src/ldk/utils.ts`. All three reviewers flagged this duplication independently.

## Findings

- **Source**: kieran-typescript-reviewer, code-simplicity-reviewer, architecture-strategist
- `tx-bridge.ts:18-20` duplicates `src/ldk/utils.ts:1-5`
- Event handler already imports `bytesToHex` from `../utils`
- Remove `txBytesToHex`, use `bytesToHex` directly at call site

## Proposed Solutions

### Option A: Import bytesToHex from ../ldk/utils in event handler (already done)
- Replace `txBytesToHex(rawTxBytes)` with `bytesToHex(rawTxBytes)` on line 248
- Remove `txBytesToHex` export from tx-bridge.ts and its tests
- **Effort**: Small (~15 lines removed)

## Technical Details

**Affected files**: `src/onchain/tx-bridge.ts`, `src/onchain/tx-bridge.test.ts`, `src/ldk/traits/event-handler.ts`, `src/ldk/traits/event-handler.test.ts`

## Acceptance Criteria

- [ ] `txBytesToHex` removed from tx-bridge.ts
- [ ] Call site uses `bytesToHex` from existing utils
- [ ] Related tests removed

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-12 | Identified during PR #8 code review | Avoid duplicating utility functions across modules |

## Resources

- PR: #8
