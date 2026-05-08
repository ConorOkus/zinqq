---
status: complete
priority: p1
issue_id: '337'
tags: [code-review, architecture, simplicity, chain-sync, pr-157]
dependencies: []
---

# `SyncLoopConfig.persistChannelManager` is optional with dead fallback path

## Problem Statement

`src/ldk/sync/chain-sync.ts:171-172` declares both `cmPersistCtx?` and
`persistChannelManager?: () => Promise<void>` as optional. The tick body at
`:233-237` branches:

```ts
if (config.persistChannelManager) {
  await config.persistChannelManager()
} else {
  await persistChannelManager(config.channelManager, config.cmPersistCtx)
}
```

The single production caller (`src/ldk/context.tsx:1058-1062`) always passes
both. The `else` branch is dead in production and re-introduces the exact
unserialized-write bug PR #157 fixes if any future caller (or test) forgets
the field. There are no `chain-sync.test.ts` callers exercising the fallback.

## Findings

- code-simplicity-reviewer P1, architecture-strategist P1, kieran-typescript P2
  all flagged independently.
- The optionality is "just-in-case extensibility added on the same commit as
  the only caller" — textbook YAGNI.
- The field name `persistChannelManager` collides visually with the imported
  module function of the same name two lines below. Rename to `schedulePersist`.

## Proposed Solutions

### Option A — Required field, drop `cmPersistCtx`, rename to `schedulePersist`

```ts
export interface SyncLoopConfig {
  // remove: cmPersistCtx?: CmPersistContext
  schedulePersist: () => Promise<void>  // required
}

// in tick():
if (cmNeedsPersist || config.channelManager.get_and_clear_needs_persistence()) {
  cmNeedsPersist = false
  try { await config.schedulePersist() }
  catch (err) { cmNeedsPersist = true; throw err }
}
```

- Drops the import of `persistChannelManager` from chain-sync.ts entirely.
- Sync loop becomes ignorant of VSS/IDB/version refs — single concern.
- Pros: eliminates footgun; single canonical persist path.
- Cons: tiny breaking change to internal API (no external consumers).
- Effort: Small (~6 LOC removed, one rename).
- Risk: Low.

### Option B — Keep optional, add invariant test

Less preferred — leaves footgun.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/sync/chain-sync.ts`, `src/ldk/context.tsx`
- **Pairs well with:** #342 (named type alias for the scheduler)

## Acceptance Criteria

- [ ] `persistChannelManager`/`schedulePersist` is required in `SyncLoopConfig`
- [ ] `cmPersistCtx` removed from `SyncLoopConfig`
- [ ] `chain-sync.ts` no longer imports `persistChannelManager` from `persist-cm.ts`
- [ ] Field renamed for clarity (no collision with module function)

## Work Log

- 2026-05-08: Applied Option A. `SyncLoopConfig` now has a single required `schedulePersist: () => Promise<void>` field. Dropped `cmPersistCtx` and the `persistChannelManager` import from `chain-sync.ts`. Removed the `cmNeedsPersist` retry latch — the scheduler owns must-retry internally now (see #335). Renamed the field to `schedulePersist` so it no longer collides with the imported module function.

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/157
- Related: #342 (named type alias)
