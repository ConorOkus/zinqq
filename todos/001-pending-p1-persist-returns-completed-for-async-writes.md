---
status: complete
priority: p1
issue_id: '001'
tags: [code-review, security, architecture, data-integrity]
dependencies: []
---

# Persist trait returns Completed for async IndexedDB writes

## Problem Statement

`persist_new_channel` and `update_persisted_channel` in `src/ldk/traits/persist.ts` fire async `idbPut()` calls but immediately return `ChannelMonitorUpdateStatus_Completed`. This tells LDK the data is safely persisted when it may not be. If the browser crashes or the IndexedDB write fails, LDK believes it has a durable backup that does not exist.

## Findings

- **File**: `src/ldk/traits/persist.ts`, lines 31-35 and 47-50
- **Identified by**: kieran-typescript-reviewer, security-sentinel, architecture-strategist
- The comment on lines 26-30 acknowledges the mismatch but the code returns `Completed` anyway
- `ChannelMonitorUpdateStatus_InProgress` exists precisely for async persistence
- Error handling is `.catch(console.error)` — failures are silently swallowed

## Proposed Solutions

### Option A: Return InProgress (Recommended)

- Return `ChannelMonitorUpdateStatus_InProgress` instead of `_Completed`
- Document that the `ChainMonitor` completion callback must be implemented when ChannelManager is added
- **Pros**: Correct contract with LDK, safe foundation for future work
- **Cons**: Requires ChainMonitor callback for full correctness (acceptable to defer)
- **Effort**: Small
- **Risk**: Low

### Option B: Synchronous write-ahead buffer

- Write to an in-memory Map synchronously, flush to IndexedDB asynchronously
- Return `Completed` only for the memory write
- **Pros**: Technically correct for same-session durability
- **Cons**: More complex, still loses data on crash before flush
- **Effort**: Medium
- **Risk**: Medium

## Recommended Action

_To be filled during triage_

## Technical Details

- **Affected files**: `src/ldk/traits/persist.ts`
- **Components**: Persist trait, IndexedDB storage layer

## Acceptance Criteria

- [ ] `persist_new_channel` returns `InProgress` instead of `Completed`
- [ ] `update_persisted_channel` returns `InProgress` instead of `Completed`
- [ ] Comment updated to reflect the chosen approach
- [ ] Error handling logs AND surfaces the failure (not just console.error)

## Work Log

| Date       | Action                        | Learnings                                               |
| ---------- | ----------------------------- | ------------------------------------------------------- |
| 2026-03-11 | Identified during code review | Async persistence must not claim synchronous completion |

## Resources

- PR: https://github.com/ConorOkus/browser-wallet/pull/2
- LDK Persist trait docs: ChannelMonitorUpdateStatus enum
