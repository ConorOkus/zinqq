---
status: complete
priority: p3
issue_id: '175'
tags: [code-review, quality]
dependencies: []
---

# Consolidate manifest backfill logic into persister

## Problem Statement

The manifest backfill in `init.ts` (lines 220-242) duplicates conflict-resolution logic that already exists in `persist.ts` `writeManifest()`. The 15-line async `.catch` handler handles conflicts identically to `writeManifest`.

**Files:** `src/ldk/init.ts:220-242`, `src/ldk/traits/persist.ts:67-87`

## Findings

- Flagged by simplicity reviewer
- ~20 LOC could be saved by having the persister handle backfill internally (e.g., call `writeManifest()` when `initialMonitorKeys` is non-empty and manifest version is unknown)
- The `backfillClient` alias on line 221 is also unnecessary

## Acceptance Criteria

- [ ] Backfill logic is handled inside `createPersister` or via an exposed method
- [ ] init.ts no longer contains manifest JSON construction or conflict handling
- [ ] Remove `backfillClient` alias
