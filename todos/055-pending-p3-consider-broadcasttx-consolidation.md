---
status: pending
priority: p3
issue_id: "055"
tags: [code-review, architecture, duplication]
dependencies: []
---

# Consider consolidating Esplora broadcast logic

## Problem Statement

Two independent broadcast paths exist: `broadcastTransaction` in `tx-bridge.ts` and `broadcast_transactions` in `broadcaster.ts`. They POST to the same Esplora `/tx` endpoint with different error handling. If retry logic is added to one, the other will drift.

## Findings

- **Source**: code-simplicity-reviewer, architecture-strategist, kieran-typescript-reviewer
- `tx-bridge.ts:23-36` vs `broadcaster.ts:8-21`
- Simplicity reviewer suggests inlining the fetch at the call site or extracting shared utility
- Architecture reviewer suggests injecting a `broadcast` callback into `createEventHandler`

## Proposed Solutions

### Option A: Inject broadcast callback into createEventHandler
- Pass `broadcast: (txHex: string) => Promise<string>` as parameter
- Eliminates ONCHAIN_CONFIG import and broadcast duplication
- **Effort**: Medium

### Option B: Inline fetch at call site, remove broadcastTransaction
- Replace with 3-line fetch call matching broadcaster pattern
- **Effort**: Small

## Technical Details

**Affected files**: `src/onchain/tx-bridge.ts`, `src/ldk/traits/event-handler.ts`

## Acceptance Criteria

- [ ] Single broadcast code path or clear callback injection

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-12 | Identified during PR #8 code review | |

## Resources

- PR: #8
