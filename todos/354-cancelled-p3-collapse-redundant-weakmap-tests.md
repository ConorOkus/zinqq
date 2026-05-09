---
status: cancelled
priority: p3
issue_id: '354'
tags: [code-review, tests, pr-160]
dependencies: []
---

# Collapse 3 redundant WeakMap tests into 1

## Problem Statement

`persist-cm.test.ts:309-368` adds three tests for ~12 lines of caching logic:

1. `returns the same scheduler instance` (lines 309-317) — pure identity check.
2. `returns distinct schedulers for distinct ChannelManagers` (lines 319-328) — verifies WeakMap keys correctly. **Tests `WeakMap`, not the code.**
3. `shares in-flight state between callers` (lines 330-368) — proves the _behavioural_ claim.

Test 3 implies tests 1 and 2: if state weren't shared, `putObject` wouldn't
be called exactly once. Tests 1 and 2 add no failure modes test 3 doesn't
already cover.

## Findings

- code-simplicity-reviewer P1 (in their P-numbering; we're calling it P3)

## Proposed Solutions

### Option A — Delete tests 1 and 2; add identity assertion to test 3

```ts
// in test 3, after `expect(vssClient.putObject).toHaveBeenCalledTimes(2)`:
expect(schedulerA).toBe(schedulerB)
```

- Pros: ~20 LOC removed; same coverage.
- Cons: identity-only regression slips through if behaviour test breaks for unrelated reasons.
- Effort: Trivial.

### Option B — Keep all 3 (pin invariants individually)

Belt-and-suspenders argument. Reasonable; cheap.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/storage/persist-cm.test.ts:309-368`

## Acceptance Criteria

- [ ] Decision pinned (collapse vs keep)

## Work Log

_(empty)_

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/160 (closed)

## Cancelled

PR #160 was closed without merging. The 3 WeakMap-specific tests this todo wanted to collapse never landed on main — there's nothing to collapse.
