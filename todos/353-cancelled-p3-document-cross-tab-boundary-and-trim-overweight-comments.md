---
status: cancelled
priority: p3
issue_id: '353'
tags: [code-review, documentation, pr-160]
dependencies: []
---

# Cleanup: trim overweight WeakMap docstring; document cross-tab boundary

## Problem Statement

`persist-cm.ts:50-58` has 12 lines of comment for 1 line of `new WeakMap`. The
"see PR #157 / see todo #341 / GC-eligible" detail is good background but
verbose. The GC argument is also irrelevant in practice — `ChannelManager`
is held forever by `nodeRef.current`, never collected, so the WeakMap will
never actually drop entries.

Separately, the docstring doesn't mention that the WeakMap protects only
intra-tab races. Cross-tab safety relies on `walletLockAcquiredAt` + the
takeover-grace check in `vss-write.ts:68`. A future contributor reading
"One scheduler instance per ChannelManager — structurally enforced via
WeakMap" can plausibly conclude that no other coordination is needed.

## Findings

- **code-simplicity-reviewer P3** (docstring overweight)
- **security-sentinel P2** (cross-tab boundary not documented)
- **architecture-strategist P3** (GC story is true but irrelevant)

## Proposed Solutions

### Option A — Trim and add cross-tab note

```ts
/**
 * One scheduler per ChannelManager. StrictMode/HMR could otherwise produce
 * two schedulers with independent state, racing each other and reintroducing
 * the 409 storm fixed in PR #157.
 *
 * This protects intra-tab races only — cross-tab safety relies on the
 * wallet-lock takeover-grace window in `vssWriteWithConflictRetry`.
 */
```

- Pros: 12 → 5 lines; cross-tab boundary explicit.
- Effort: Trivial.
- Risk: None.

### Option B — Subsumed by #350

If scheduler moves to `init.ts`, the WeakMap (and its docstring) goes away.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/storage/persist-cm.ts:50-58`

## Acceptance Criteria

- [ ] Docstring is concise OR scheduler moved per #350

## Work Log

_(empty)_

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/160 (closed)
- `src/ldk/storage/vss-write.ts` (cross-tab takeover-grace lives here)

## Cancelled

PR #160 was closed without merging. The overweight WeakMap docstring no longer exists (no WeakMap). Cross-tab boundary doc could still be valuable for `vss-write.ts` itself, but that's a separate concern from this todo's scope.
