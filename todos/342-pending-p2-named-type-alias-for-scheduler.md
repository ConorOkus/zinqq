---
status: pending
priority: p2
issue_id: '342'
tags: [code-review, typescript, naming, pr-157]
dependencies: ['337']
---

# Add named type alias for the scheduler; rename ambiguous config field

## Problem Statement

`createChannelManagerPersistScheduler` returns `() => Promise<void>` — a thin
type that hides important semantics (coalesced, single in-flight, may resolve
without persisting _your_ state). The `SyncLoopConfig` field is also named
`persistChannelManager`, which collides visually with the imported module
function `persistChannelManager` from `persist-cm.ts` two lines below in
`chain-sync.ts:234`.

A reader of `chain-sync.ts:234` has no signal that
`await config.persistChannelManager()` differs from
`await persistChannelManager(...)` from the import. They have crucially
different semantics.

## Findings

- kieran-typescript-reviewer P2.
- Pairs with #337 (which already proposes renaming + dropping the fallback).

## Proposed Solutions

### Option A — Named type + rename field

```ts
// persist-cm.ts
/**
 * Coalesces concurrent CM persist requests into a single in-flight + at most
 * one trailing run. Returned promise resolves when the loop finishes; see
 * #339 for caveats about which iteration "your" mutation lands in.
 */
export type ChannelManagerPersistScheduler = () => Promise<void>

export function createChannelManagerPersistScheduler(
  cm: ChannelManager,
  ctx: CmPersistContext = {}
): ChannelManagerPersistScheduler { ... }

// chain-sync.ts
export interface SyncLoopConfig {
  schedulePersist: ChannelManagerPersistScheduler  // required (#337)
}
```

- Pros: contract is documented; field name no longer collides with module function.
- Cons: tiny type churn.
- Effort: Trivial.
- Risk: None.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/storage/persist-cm.ts`, `src/ldk/sync/chain-sync.ts`, `src/ldk/context.tsx`

## Acceptance Criteria

- [ ] `ChannelManagerPersistScheduler` exported from `persist-cm.ts`
- [ ] `SyncLoopConfig` field renamed (e.g., `schedulePersist`)
- [ ] No identifier shadowing between `chain-sync.ts` import and config field

## Work Log

_(empty)_

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/157
- Related: #337 (drop fallback, make required)
