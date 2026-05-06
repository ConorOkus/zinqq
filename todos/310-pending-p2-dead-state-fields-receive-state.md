---
status: pending
priority: p2
issue_id: '310'
tags: [code-review, simplicity, dead-code, pr-150]
dependencies: []
---

# Remove dead `quoteStatus`, `consecutiveUpwardReQuotes`, `retryStep` fields

## Problem Statement

The `'jit-review'` (kind: `'commit'`) state variant carries `quoteStatus: 'fresh' | 'reQuoting' | 'updated'` and `consecutiveUpwardReQuotes: number`, but neither is read anywhere — both are written once with literal `'fresh'` / `0` and never updated or consumed. The `'jit-error'` step carries `retryStep: 'jit-quoting'`, which is the only literal value the field ever holds.

These were placeholders for Phase 4 work (stale-quote re-fetch, anti-griefing cap) that was deferred to PR 2. They're dead state today.

## Findings

- **File**: `src/pages/Receive.tsx:39-40` (`quoteStatus`, `consecutiveUpwardReQuotes`)
- **File**: `src/pages/Receive.tsx:51` (`retryStep`)
- **File**: `src/pages/Receive.tsx:194-195` (set to `'fresh'`/`0`, never updated)
- **Identified by**: kieran-typescript-reviewer, code-simplicity-reviewer (#2, #6 of "YAGNI Violations")

## Proposed Solutions

### Option A: Remove dead fields now; re-add when Phase 4 lands (Recommended)

- Trim `'jit-review' & kind: 'commit'` to `{ kind: 'commit', amountSats, quote }`
- Trim `'jit-error'` to `{ step: 'jit-error', message }`
- The retry handler can hardcode the next step
- **Pros**: ~5 LOC removed, types are honest, no Phase-4 obligation embedded in the type
- **Cons**: Phase 4 will need to re-add `quoteStatus` and the cap counter
- **Effort**: Small
- **Risk**: None — fields are unused

### Option B: Keep as scaffolding for Phase 4

- Document with a comment that these are reserved for Phase 4
- **Pros**: Phase 4 has placeholders ready
- **Cons**: Dead state ships in production

## Recommended Action

(Filled during triage — Option A is the YAGNI default)

## Technical Details

- **Affected files**: `src/pages/Receive.tsx` (state type, state setters in the success branch of the main effect, `'jit-error'` setters in `handleGenerateInvoice`)

## Acceptance Criteria

- [ ] `quoteStatus`, `consecutiveUpwardReQuotes`, `retryStep` removed from `ReceiveState`
- [ ] All setter call sites updated
- [ ] `pnpm test` and `pnpm lint` pass

## Work Log

(Empty)

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/150
- Plan section: "Phase 4: Stale quote re-fetch + lifecycle hooks" (deferred to PR 2)
