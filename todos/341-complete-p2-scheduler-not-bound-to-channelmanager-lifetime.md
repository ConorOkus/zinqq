---
status: complete
priority: p2
issue_id: '341'
tags: [code-review, lifecycle, react, strictmode, pr-157]
dependencies: ['338']
---

# Scheduler lifetime not bound to ChannelManager — StrictMode/HMR can produce two

## Problem Statement

`src/ldk/context.tsx:931-934`:

```ts
const scheduleChannelManagerPersist = createChannelManagerPersistScheduler(
  node.channelManager,
  cmPersistCtx
)
```

The scheduler is created inside `.then(node => …)` of the init promise. While
`initPromise` deduplicates in-flight inits, the _provider effect itself_ can
still execute twice in dev (React StrictMode) or after fast-refresh. Each run
produces a new scheduler closure with its own `inFlight=null` and
`pendingDirty=false`.

If two schedulers exist concurrently for the **same** `node.channelManager`,
they each have independent in-flight state — both will issue concurrent
`putObject` against the same key with the same expected version — defeating
the whole purpose of this PR.

## Findings

- security-sentinel P2-5.
- architecture-strategist P1 (related, focused on teardown in #338).

## Proposed Solutions

### Option A — `WeakMap<ChannelManager, Scheduler>`

```ts
const SCHEDULERS = new WeakMap<ChannelManager, () => Promise<void>>()
export function createChannelManagerPersistScheduler(cm, ctx) {
  const existing = SCHEDULERS.get(cm)
  if (existing) return existing
  const sched = makeScheduler(cm, ctx)
  SCHEDULERS.set(cm, sched)
  return sched
}
```

- Pros: structurally guarantees one scheduler per CM regardless of caller.
- Cons: WeakMap retention — fine because key is the CM itself.
- Effort: Small.
- Risk: Low.

### Option B — Attach scheduler to `node` object in `initializeLdk`

Move scheduler creation into `init.ts` and expose `node.persistCm` to callers.

- Pros: lifetime mirrors `node` lifetime exactly.
- Cons: changes the shape of `node`; ripples to tests and callers.
- Effort: Medium.
- Risk: Low.

### Option C — Memoize via `useMemo` keyed on `node`

React-idiomatic, but `useMemo` runs in render, not in effect — the scheduler
is currently created in effect, after init resolves. Awkward fit.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/storage/persist-cm.ts`, possibly `src/ldk/init.ts`, `src/ldk/context.tsx`

## Acceptance Criteria

- [ ] At most one scheduler per `ChannelManager` instance, structurally enforced
- [ ] Test: calling factory twice with the same `cm` returns the same scheduler

## Work Log

### 2026-05-08 — Approved for work

**By:** Claude Triage System

**Actions:**

- Issue approved during triage session
- Status changed from pending → ready

**Learnings:**

- The P1 cancel-on-teardown (#338) covers StrictMode's "two effect runs" case in practice, but a WeakMap gives a structural guarantee that no future caller can accidentally create two schedulers per CM.

### 2026-05-08 — Resolved (Option A)

**Implementation:**

`SCHEDULERS_BY_CM = new WeakMap<ChannelManager, ChannelManagerPersistScheduler>` in `persist-cm.ts`. `createChannelManagerPersistScheduler(cm, ctx)` now checks the map first and returns the cached scheduler if one exists — repeated calls with the same `cm` (e.g. StrictMode double-effect, fast-refresh, future code paths that recreate `LdkProvider`) share state. The first call's `ctx` is captured by the closure; later `ctx` arguments are silently ignored (callers should pass the same VSS client/version ref).

WeakMap means no manual cleanup: when LDK drops the `ChannelManager` reference, the entry GC's automatically.

**Tests:**

- `returns the same scheduler instance when called twice with the same ChannelManager`
- `returns distinct schedulers for distinct ChannelManagers`
- `shares in-flight state between callers that pass the same ChannelManager` (simulates StrictMode: two factory calls, second schedule() coalesces into the first's in-flight)

Total persist-cm tests: 23 (was 20). Full suite: 474 pass.

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/157
- Related: #338 (teardown drain)
