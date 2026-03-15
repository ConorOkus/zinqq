---
status: complete
priority: p1
issue_id: "052"
tags: [code-review, testing, fund-safety]
dependencies: []
---

# Add test for funding_transaction_generated failure path

## Problem Statement

The `funding_transaction_generated` error branch (line 239-244) has no test coverage. If this call fails, the cache must NOT be populated and the changeset must NOT be persisted — otherwise a transaction LDK doesn't know about could be cached and later broadcast.

## Findings

- **Source**: kieran-typescript-reviewer
- **File**: `src/ldk/traits/event-handler.ts:239-244`
- Mock always returns `{ is_ok: () => true }` — never exercises the failure path
- This is a critical fund-safety error path

## Proposed Solutions

### Option A: Add test with is_ok returning false
- Set `mockFundingTransactionGenerated` to return `{ is_ok: () => false }`
- Verify: error logged, cache NOT populated, changeset NOT persisted
- **Effort**: Small
- **Risk**: Low

## Technical Details

**Affected files**: `src/ldk/traits/event-handler.test.ts`

## Acceptance Criteria

- [ ] Test where `funding_transaction_generated` returns error result
- [ ] Verify cache is empty after failure
- [ ] Verify `putChangeset` is NOT called after failure

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-12 | Identified during PR #8 code review | Critical error paths need explicit test coverage |

## Resources

- PR: #8
