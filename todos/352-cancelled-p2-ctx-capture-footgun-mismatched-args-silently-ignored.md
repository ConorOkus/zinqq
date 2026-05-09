---
status: cancelled
priority: p2
issue_id: '352'
tags: [code-review, api-design, pr-160]
dependencies: []
---

# `ctx` capture footgun: later factory calls silently drop the new ctx argument

## Problem Statement

`persist-cm.ts:73-86`:

```ts
export function createChannelManagerPersistScheduler(
  cm: ChannelManager,
  ctx: CmPersistContext = {}
): ChannelManagerPersistScheduler {
  const existing = SCHEDULERS_BY_CM.get(cm)
  if (existing) return existing
  // ...
}
```

The first call's `ctx` (vssClient, cmVersionRef) is captured by the closure.
Later calls' `ctx` arguments are silently ignored. The JSDoc warns about
this honestly — but the **type signature is unchanged**, so it accepts a
`ctx` argument that does nothing.

Today this is fine because `cmPersistCtx` is constructed once inside
`doInitializeLdk` (init.ts:761-764) and `initPromise` returns the same
object reference every time. So today's callers always pass the identical
ctx. **Load-bearing invariant living entirely in coupling between two files
with nothing enforcing it.**

If a future caller (recovery flow, offline-mode toggle, test author) passes
a different `vssClient` or `cmVersionRef` to a CM that already has a cached
scheduler, the new ctx is silently discarded. Failure mode: writes go to
the old VSS endpoint, version drift across persisters. Hours-of-debugging
territory. For a Lightning wallet whose CM state controls fund safety, this
is the kind of latent footgun worth closing now.

Specific scenario flagged by security review: if the first ctx had
`vssClient: null` (VSS-disabled boot path that later enables VSS),
subsequent calls passing a real client would write only to IDB. **Silent
VSS bypass.**

## Findings

- **kieran-typescript-reviewer P2** ("first ctx wins is a smell")
- **security-sentinel P2** (silent VSS bypass scenario)

## Proposed Solutions

### Option A — Subsumed by #350

If scheduler creation moves to `init.ts`, the second-call ambiguity disappears
entirely (`ctx` is captured once at construction, no second-arg ever).

### Option B — Split the API into create/get

```ts
export function createChannelManagerPersistScheduler(cm, ctx): Scheduler { ... }
export function getChannelManagerPersistScheduler(cm): Scheduler | null { ... }
```

Callers who want the cached one use `get`; callers constructing the first
time use `create`. Misuse becomes a compile error.

- Pros: type-level correctness.
- Cons: more API surface; one production caller to update.
- Effort: Small.
- Risk: Low.

### Option C — Dev-mode assertion on mismatch

```ts
if (existing && import.meta.env.DEV) {
  // assert ctx.vssClient === capturedCtx.vssClient (etc.)
  // throw on mismatch
}
```

Cheap; catches future foot-shooting; doesn't touch the API.

- Pros: trivial; works as defense-in-depth even if Option A or B lands.
- Cons: dev-only; prod still silently ignores.
- Effort: Trivial.
- Risk: Low.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/storage/persist-cm.ts:73-86`
- **One production caller:** `src/ldk/context.tsx:932-936`

## Acceptance Criteria

- [ ] Either #350 lands (eliminates the issue), or Option B/C ships with this PR
- [ ] Test: factory called twice with conflicting `vssClient` either throws or warns or rebuilds (decision pinned)

## Work Log

_(empty)_

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/160 (closed)
- Related: #350 (subsumed)

## Cancelled

PR #160 was closed without merging. #350 makes `createChannelManagerPersistScheduler` a single-call site — `init.ts` is the only caller. No "later ctx wins/loses" ambiguity because there's only one ctx ever passed.
