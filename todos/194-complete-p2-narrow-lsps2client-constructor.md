---
status: complete
priority: p2
issue_id: '194'
tags: [code-review, architecture, lsps2]
---

# Narrow LSPS2Client constructor and remove dead fields

## Problem Statement

`LSPS2Client` accepts the full `LspsMessageHandlerResult` (4 fields) but only uses `sendRequest`. The `lspsHandlerDestroy` field on `LdkNode` is never called. These create unnecessary coupling.

## Findings

- **TS reviewer finding 6:** Interface segregation violation — client receives `handler`, `destroy`, `setFlushCallback` it never uses.
- **Simplicity reviewer findings 3-4:** `lspsHandlerDestroy` stored on `LdkNode` (init.ts:91, 647) is dead code. Context.tsx:852-854 explicitly says it should not be called.
- **Architecture reviewer:** Client depends on a broader interface than needed.

## Proposed Solutions

1. **Narrow constructor to `sendRequest` only** — Change `LSPS2Client` constructor to accept `{ sendRequest: ... }`. Remove `lspsHandlerDestroy` from `LdkNode` interface.
   - Pros: Clean interface, removes dead code
   - Cons: None
   - Effort: Small
   - Risk: Low

## Technical Details

- **Affected files:** `src/ldk/lsps2/client.ts`, `src/ldk/init.ts` (lines 91, 520, 647)
- **Effort:** Small

## Acceptance Criteria

- [ ] `LSPS2Client` constructor accepts only `sendRequest`
- [ ] `lspsHandlerDestroy` removed from `LdkNode` interface
- [ ] Build and tests pass

## Resources

- Branch: feat/lsps2-jit-channel-receive
