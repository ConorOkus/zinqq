---
status: cancelled
priority: p2
issue_id: '351'
tags: [code-review, tests, pr-160]
dependencies: ['349']
---

# `SCHEDULERS_BY_CM` WeakMap leaks across vitest test cases

## Problem Statement

`persist-cm.test.ts:305-307`'s `beforeEach` only resets `idbPut`. Each test
creates a fresh `cm` object via `makeDirtyCm()`, so identity-keyed WeakMap
reads currently miss between tests — but that's brittle. The moment someone
adds a test that reuses a `cm` reference (a `describe.each` block, a shared
fixture for "test these 5 invariants on the same CM"), they'll get cross-
contamination from the previous test's cancelled or stale scheduler.

There's no way to clear the WeakMap from outside the module today. The fix
follows the established `__resetWalletLockAcquiredAtForTests` pattern at
`init.ts:184`.

## Findings

- architecture-strategist P2

## Proposed Solutions

### Option A — Export `__resetSchedulersForTests`

```ts
// persist-cm.ts
export function __resetSchedulersForTests(): void {
  // WeakMap doesn't expose a clear() — but we can replace the binding
  // (since the module-level const can't be reassigned, use a Map instead
  // for tests, or refactor to allow reset)
}
```

The cleanest variant: change the WeakMap to a regular Map gated on `import.meta.env.DEV` so tests can clear it. Or expose a `delete(cm)` helper and have tests track CMs they've cached.

- Pros: matches existing pattern; closes test-isolation hole.
- Cons: test-only export pollutes public API surface (mitigated by `__` prefix and JSDoc).
- Effort: Small.
- Risk: Low.

### Option B — Subsumed by #350

If the scheduler moves to `init.ts`, this todo becomes moot — there's no
WeakMap to reset.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/storage/persist-cm.ts`, `src/ldk/storage/persist-cm.test.ts`
- **Pattern reference:** `src/ldk/init.ts:184` (`__resetWalletLockAcquiredAtForTests`)

## Acceptance Criteria

- [ ] Either `__resetSchedulersForTests` exported and called in `beforeEach`, OR scheduler moved to `init.ts` (#350)

## Work Log

_(empty)_

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/160 (closed)
- Related: #349 (also cancelled), #350 (subsumes this)

## Cancelled

PR #160 was closed without merging. #350 deletes the WeakMap entirely — no module-level cache, no test isolation hole.
