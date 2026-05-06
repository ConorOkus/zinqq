---
status: pending
priority: p3
issue_id: 299
tags: [code-review, tests, pr-148]
dependencies: []
---

# P3 — `vi.fn<AttemptFn>` annotation noise in jit-failover.test.ts

## Problem Statement

The failover test file annotates each mock as `const attempt: ReturnType<typeof vi.fn<AttemptFn>> = vi.fn<AttemptFn>(impl)`. The left-hand annotation is redundant — `vi.fn<AttemptFn>(impl)` already infers the right return type. Stripping it removes ~25% of test boilerplate without losing safety.

## Findings

- `src/ldk/lsp/jit-failover.test.ts` — roughly 8 occurrences of the redundant pattern.
- `vi.fn<T>(impl)` is generic over the function signature; the resulting `Mock<T>` is fully inferred.

## Proposed Solutions

### Option A — Drop the LHS annotation everywhere

`const attempt = vi.fn<AttemptFn>(impl)`. Type stays exact via the generic argument.

**Pros:** Less noise; identical type safety.
**Cons:** None.
**Effort:** Small.
**Risk:** Low.

### Option B — Helper factory

`const makeAttempt = (impl: AttemptFn) => vi.fn<AttemptFn>(impl)`.

**Pros:** Centralises pattern.
**Cons:** Indirection for trivial gain.
**Effort:** Small.
**Risk:** Low.

## Recommended Action

Option A — straight mechanical cleanup.

## Technical Details

- **Affected files:** `src/ldk/lsp/jit-failover.test.ts`.

## Acceptance Criteria

- [ ] No `ReturnType<typeof vi.fn<...>>` annotations in the test file.
- [ ] `tsc --noEmit` and `vitest run` stay green.

## Work Log

| Date       | Action                                    | Notes                      |
| ---------- | ----------------------------------------- | -------------------------- |
| 2026-05-05 | Discovered during `/ce:review` of PR #148 | kieran-typescript-reviewer |

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/148
- Source: `src/ldk/lsp/jit-failover.test.ts`
