---
status: complete
priority: p2
issue_id: "033"
tags: [code-review, quality]
dependencies: ["017"]
---

# onPersistFailure callback is returned but never wired up

## Problem Statement

`createPersister()` returns an `onPersistFailure` callback handler, but `init.ts` line 110 destructures only `persist` and `setChainMonitor`, discarding the callback. If all 3 persist retries fail, the error goes only to `console.error` — the application has no way to react.

## Findings

- **Source:** TypeScript Reviewer (re-review)
- **Location:** `src/ldk/init.ts` line 110, `src/ldk/traits/persist.ts` line 109

## Proposed Solutions

### Option A: Wire it up in init.ts
- Destructure `onPersistFailure` and store the handler on LdkNode or pass to context
- Context can display a critical error banner
- **Effort:** Small

### Option B: Remove the callback (YAGNI)
- Remove `PersistError`, `onPersistFailure`, `failureHandler` — rely on console.error + LDK's built-in halt
- Add it back when UI error reporting is built
- **Effort:** Small

## Acceptance Criteria

- [ ] Either onPersistFailure is wired to something that surfaces the error, OR it's removed

## Work Log

| Date | Action | Details |
|------|--------|---------|
| 2026-03-11 | Created | From PR #3 re-review |
