---
status: pending
priority: p2
issue_id: '345'
tags: [code-review, vss, defensive-code, pr-157]
dependencies: []
---

# Inline VSS conflict retry in `persistChannelManager` is now misleading defensive code

## Problem Statement

`src/ldk/storage/persist-cm.ts:37-48` retries once on a 409:

```ts
if (isVssConflict(err)) {
  const serverObj = await vssClient.getObject(CM_VSS_KEY)
  const correctedVersion = serverObj ? serverObj.version : 0
  versionRef.current = correctedVersion
  const newVersion = await vssClient.putObject(CM_VSS_KEY, data, correctedVersion)
  versionRef.current = newVersion
}
```

With the scheduler in front of every call site (after #337 lands), within a
single tab there can never be two in-flight `putObject` for this key. The
inline retry only fires for:
1. Cross-tab dual-writer (BroadcastChannel race window before takeover) — narrow.
2. Server version drifted while tab was idle — possible after long backgrounding.

The retry-once **without re-reading the dirty-bit/state** means in case (1)
the loser-tab's stale CM bytes silently overwrite the winner-tab's fresher
state. This is a real correctness gap (#347 covers the cross-tab issue end-to-end).

In case (2) the inline retry is correct but reachable from only one path now.
The docstring at `:24-30` says "Version conflicts are resolved inline" — that
undersells the danger.

## Findings

- architecture-strategist P2.
- Connects to #347 (cross-tab BroadcastChannel leader election).

## Proposed Solutions

### Option A — Remove inline retry, propagate to scheduler

Let the scheduler propagate failure to the chain-sync `cmNeedsPersist` retry
latch (which exists at `chain-sync.ts:184, 230, 239`). Simpler; one retry path.

- Pros: removes silent overwrite risk (loser-tab no longer auto-clobbers).
- Cons: startup version-skew now needs handling — possibly handled by the
  startup version-cache seeding from PR #114.
- Effort: Small.
- Risk: Medium (need to confirm startup path still works without inline retry).

### Option B — Document scope; keep retry but only for startup case

Tighten the conditional: retry only if `versionRef.current === 0` (startup
state). Otherwise, throw and let the scheduler/sync-loop handle it.

- Pros: explicit about which case is covered.
- Cons: introduces another edge-case branch.
- Effort: Small.
- Risk: Low.

### Option C — Leave as-is, document

Add a prominent comment explaining that this retry is *only* safe when the
caller can guarantee no concurrent writer for the key. With the scheduler in
front, that's true intra-tab but not inter-tab.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/storage/persist-cm.ts`
- **Verify:** does the chain-sync retry latch + scheduler combination cover
  all the cases the inline retry was protecting?

## Acceptance Criteria

- [ ] Decision: remove / scope-document / leave-with-doc
- [ ] If kept, docstring explicitly covers cross-tab implications
- [ ] Test: cross-tab race scenario does not silently clobber fresh state

## Work Log

_(empty)_

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/157
- Related: #347 (cross-tab leader election)
