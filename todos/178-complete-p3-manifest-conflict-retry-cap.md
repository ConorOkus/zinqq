---
status: complete
priority: p3
issue_id: '178'
tags: [code-review, reliability]
dependencies: []
---

# Increase manifest conflict retry cap to match design doc

## Problem Statement

The `writeManifest()` conflict handler retries only once after re-fetching the server version. The VSS dual-write design doc (`docs/solutions/design-patterns/vss-dual-write-persistence-with-version-conflict-resolution.md`) specifies conflict retries should be capped at 5 with re-fetch. A single retry may fail under multi-device concurrent writes.

**Files:** `src/ldk/traits/persist.ts:97-117`

## Findings

- Flagged by learnings researcher cross-referencing design doc (PR #38 review)
- `persistWithRetry` already implements the 5-retry cap correctly
- Single-device (Web Lock) makes multi-conflict very unlikely today
- Multi-device is a stated design goal (VSS exists for cross-device recovery)

## Acceptance Criteria

- [ ] `writeManifest` conflict resolution retries up to 3-5 times (matching design doc guidance)
- [ ] Each retry re-fetches server version and merges keys before retrying
- [ ] After cap, falls through to warning log (current behavior)
