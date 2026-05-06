---
status: pending
priority: p3
issue_id: 300
tags: [code-review, tests, pr-148]
dependencies: []
---

# P3 — `__resetForTests` is public production export

## Problem Statement

`lqwd-discovery.ts` exports a `__resetForTests` function from a production module. Even with the convention prefix, anything exported can be imported by production code. A future contributor unfamiliar with the convention could call it and silently kneecap the memo.

## Findings

- `src/ldk/lsp/lqwd-discovery.ts:71-73`:
  ```ts
  /** Test-only: clear the memoised promise. Not exported to barrel. */
  export function __resetForTests(): void {
    inflight = null
  }
  ```

## Proposed Solutions

### Option A — Replace with `vi.resetModules()` in beforeEach

Tests call `vi.resetModules()` and dynamically re-import the module to get a fresh closure. No production-side helper needed.

**Pros:** Production module has zero test-only surface area.
**Cons:** Tests must use dynamic `await import(...)`.
**Effort:** Small.
**Risk:** Low.

### Option B — Gate via NODE_ENV

`if (process.env.NODE_ENV !== 'test') throw new Error('test-only')` inside the helper.

**Pros:** Cheapest change; signals intent at runtime too.
**Cons:** Still pollutes the public API; relies on NODE_ENV being set in tests.
**Effort:** Trivial.
**Risk:** Low.

### Option C — Leave as is

The barrel-exclusion comment is enough; the prefix is a strong convention.

**Pros:** No churn.
**Cons:** Smell remains.
**Effort:** None.
**Risk:** Low.

## Recommended Action

Option A is the cleanest, but the existing convention is widely understood. Defer unless we adopt a project-wide rule.

## Technical Details

- **Affected files:** `src/ldk/lsp/lqwd-discovery.ts`, `src/ldk/lsp/lqwd-discovery.test.ts` (or equivalent).

## Acceptance Criteria

- [ ] Either remove `__resetForTests` (Option A), gate it (Option B), or document the decision to keep (Option C).
- [ ] Tests / build / lint stay green.

## Work Log

| Date       | Action                                    | Notes                                                 |
| ---------- | ----------------------------------------- | ----------------------------------------------------- |
| 2026-05-05 | Discovered during `/ce:review` of PR #148 | kieran-typescript-reviewer + code-simplicity-reviewer |

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/148
- Source: `src/ldk/lsp/lqwd-discovery.ts:71-73`
