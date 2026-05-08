---
status: pending
priority: p3
issue_id: '346'
tags: [code-review, theoretical, pr-157]
dependencies: []
---

# Theoretical microtask race window between IIFE settlement and `.finally`

## Problem Statement

`src/ldk/storage/persist-cm.ts:68-75`:

```ts
inFlight = (async () => {
  do { pendingDirty = false; await persistChannelManager(cm, ctx) }
  while (pendingDirty)
})().finally(() => { inFlight = null })
```

There is a microtask gap between the IIFE promise settling and `.finally`
running. If a `schedulePersist()` lands inside that gap (only possible from
another microtask, not from a sync handler), it sees `inFlight !== null`,
sets `pendingDirty = true`, returns the already-settled promise, and the
dirty flag is then silently cleared by the do/while having already exited.

Neither current call site can trigger this:
- `context.tsx:1127` — sync timer/socket callback.
- `chain-sync.ts:234` — awaited inline; one schedulePersist per tick.

But it's a foot-gun for any future caller chaining off another microtask.

## Findings

- kieran-typescript-reviewer P3.

## Proposed Solutions

### Option A — Re-arm in `.finally`

```ts
.finally(() => {
  inFlight = null
  if (pendingDirty) scheduleChannelManagerPersist()
})
```

- Pros: closes the gap.
- Cons: re-entrancy via `finally` is subtle; if the re-arm itself fails,
  there's no awaiter to surface the error.

### Option B — Fold loop into `.then` chaining

Avoid the IIFE-then-finally gap entirely.

### Option C — Document, leave as P3

Today's call sites can't trigger it. Cheaper to document than to harden.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/storage/persist-cm.ts`

## Acceptance Criteria

- [ ] Either gap is closed, or comment documents the constraint

## Work Log

_(empty)_

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/157
