---
status: complete
priority: p1
issue_id: "051"
tags: [code-review, architecture, testing]
dependencies: []
---

# Move fundingTxCache inside createEventHandler closure

## Problem Statement

`fundingTxCache` is a module-level `Map` (global mutable singleton). This causes: (1) state leaks between test runs, (2) shared state if multiple event handlers are created, (3) no cleanup path on `cleanup()`. Multiple reviewers flagged this independently.

## Findings

- **Source**: kieran-typescript-reviewer, architecture-strategist
- **File**: `src/ldk/traits/event-handler.ts:41`
- Module-level `const fundingTxCache = new Map<string, string>()` persists across handler instances
- `cleanup()` does not clear the cache
- Tests work by accident — each test creates its own handler but shares the cache

## Proposed Solutions

### Option A: Move into createEventHandler closure (Recommended)
- Declare `fundingTxCache` inside `createEventHandler`, pass to `handleEvent`
- Add `fundingTxCache.clear()` to `cleanup()`
- **Pros**: Proper scoping, deterministic cleanup, test isolation
- **Cons**: Requires adding `fundingTxCache` parameter to `handleEvent`
- **Effort**: Small
- **Risk**: Low

## Recommended Action

Option A — straightforward refactor.

## Technical Details

**Affected files**: `src/ldk/traits/event-handler.ts`, `src/ldk/traits/event-handler.test.ts`

## Acceptance Criteria

- [ ] `fundingTxCache` is local to `createEventHandler`
- [ ] `cleanup()` calls `fundingTxCache.clear()`
- [ ] Tests remain green with isolated cache per handler instance

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-12 | Identified during PR #8 code review | Module-level mutable state is a testing hazard |

## Resources

- PR: #8
