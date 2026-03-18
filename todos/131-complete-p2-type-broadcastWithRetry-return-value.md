---
status: pending
priority: p2
issue_id: "131"
tags: [code-review, quality, architecture]
---

# Type broadcastWithRetry return value as discriminated union

## Problem Statement

`broadcastWithRetry()` returns `Promise<string>` but the actual values are three distinct categories: a real txid, `'in-flight'`, or `'already-broadcast'`. Callers like `sweep.ts` and `event-handler.ts` treat the return as a txid unconditionally, which produces misleading logs (e.g., "txid: already-broadcast").

## Findings

- Flagged by 4/4 review agents (TypeScript, Security, Simplicity, Agent-Native)
- `src/ldk/traits/broadcaster.ts` lines 12, 35 return sentinel strings
- `src/ldk/sweep.ts` line 124 stores return in `SweepResult.txid`
- `src/ldk/traits/event-handler.ts` line 458 logs return as txid

## Proposed Solutions

### Option A: Discriminated union return type
```typescript
type BroadcastResult =
  | { status: 'ok'; txid: string }
  | { status: 'in-flight' }
  | { status: 'already-broadcast' }
```
- Pros: Type-safe, forces callers to handle each case
- Cons: More verbose at call sites
- Effort: Small

### Option B: Keep string but document sentinels in JSDoc
- Pros: No caller changes needed
- Cons: No compile-time safety
- Effort: Tiny

## Technical Details

- **Affected files:** `src/ldk/traits/broadcaster.ts`, `src/ldk/sweep.ts`, `src/ldk/traits/event-handler.ts`, `src/ldk/traits/broadcaster.test.ts`

## Acceptance Criteria

- [ ] Return type prevents accidentally using sentinel as txid
- [ ] All callers handle each variant explicitly
- [ ] Tests updated
