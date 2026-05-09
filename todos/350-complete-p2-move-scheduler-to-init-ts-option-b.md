---
status: complete
priority: p2
issue_id: '350'
tags: [code-review, architecture, lifecycle, pr-160]
dependencies: []
---

# Move scheduler ownership to `init.ts` (todo #341 Option B) — eliminates the WeakMap entirely

## Problem Statement

PR #160 chose Option A (WeakMap cache) over Option B (attach scheduler to
the `node` object in `init.ts`). Architecture review pushed back: the
WeakMap solution introduces module-level mutable state and the cancel-
poisons-cache hazard (#349) right after PR #344 was specifically cleaning
up module-level state in this layer. Pattern parity with `known-peers.ts`
is also broken — `known-peers` uses explicit `setKnownPeersVssClient` init
called from `init.ts:486`.

Option B (proposed but deferred at triage time) attaches the scheduler to
the `node` object returned from `initializeLdk`. Lifetime mirrors the
`ChannelManager` exactly. No cache needed. No `ctx`-capture ambiguity. No
test isolation problem. No `cancel()` interaction with caching.

## Findings

- **architecture-strategist P2** ("the WeakMap is at the wrong layer")
- Resolves or dramatically simplifies #349, #351, #352, #353 in one stroke
- Original triage rejected this with "changes the shape of `node`; ripples
  to tests" — but `InitResult` already returns `cmPersistCtx` as a sibling
  of `node`, so adding `cmPersistScheduler` is a one-line addition

## Proposed Solutions

### Option A — Implement #341 Option B properly

```ts
// init.ts (around line 760)
const cmPersistCtx: CmPersistContext = {
  vssClient,
  cmVersionRef: { current: cmInitialVersion },
}
const cmPersistScheduler = createChannelManagerPersistScheduler(
  node.channelManager,
  cmPersistCtx
)
return { node, cmPersistCtx, cmPersistScheduler, ... }

// persist-cm.ts: drop the WeakMap entirely, keep factory pure

// context.tsx: destructure and use directly
const { node, cmPersistScheduler } = await initializeLdk(...)
```

- Pros: structural fix; eliminates #349, #351, #352, #353; pattern parity
  with `known-peers.ts`.
- Cons: changes `InitResult` shape; init tests need updating.
- Effort: Medium.
- Risk: Low.

### Option B — Patch the WeakMap (do #349 only)

Keep the current shape; just fix the cancel/cache interaction. Doesn't
address the layering concerns or pattern divergence.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/init.ts:217,760-764,837`,
  `src/ldk/storage/persist-cm.ts` (delete WeakMap),
  `src/ldk/context.tsx:893,932-936` (use from InitResult)
- **Pattern reference:** `src/ldk/storage/known-peers.ts:14-22` (the
  explicit-init pattern this PR diverges from)

## Acceptance Criteria

- [ ] Scheduler is constructed once in `init.ts` and exposed on `InitResult`
- [ ] WeakMap deleted from `persist-cm.ts`
- [ ] `context.tsx` destructures the scheduler instead of constructing it
- [ ] Pattern matches `known-peers.ts` (explicit init from `init.ts`)

## Work Log

### 2026-05-08 — Resolved

**Implementation:**

- `init.ts`: imports `createChannelManagerPersistScheduler`; constructs the scheduler after `node: LdkNode` is built; adds `cmPersistScheduler: ChannelManagerPersistScheduler` to `InitResult`.
- `persist-cm.ts`: factory stays pure — no WeakMap, no caching layer. Same shape as before PR #160.
- `context.tsx`: destructures `cmPersistScheduler: persistScheduler` from `InitResult`, holds the reference for teardown. Drops the `createChannelManagerPersistScheduler` import.
- `init-recovery.test.ts`: stub mock for `./storage/persist-cm` updated to provide a no-op `createChannelManagerPersistScheduler` (the existing `vi.mock(..., () => ({}))` no longer satisfies init.ts's import).

**Closes:** #341, #349, #351, #352, #353 in one stroke. #354 also moot (no WeakMap → no WeakMap-specific tests to collapse).

**Tests:** all 471 pass unchanged (no new tests added; the contract is enforced by TypeScript — there's exactly one `createChannelManagerPersistScheduler` call site in production code).

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/160
- Original triage: `todos/341-complete-p2-scheduler-not-bound-to-channelmanager-lifetime.md` (Option B was discussed but deferred)
- Pattern reference: PR #159 (#344 — extract serial-vss-persister) for `known-peers.ts` style
