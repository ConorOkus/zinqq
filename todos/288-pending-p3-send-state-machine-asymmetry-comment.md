---
status: pending
priority: p3
issue_id: '288'
tags: [code-review, docs, send-flow]
dependencies: []
---

# `Send.tsx`: comment why `isBroadcasting` is a boolean, not a `SendStep` variant

## Problem Statement

Todo 271 collapsed the `oc-broadcasting` discriminated-union variant into a local `isBroadcasting: boolean` because the broadcast is sub-second and the full-screen spinner only flashed. The Lightning flow still uses `ln-sending` as a discrete `SendStep` variant because it polls `list_recent_payments` and represents a long-lived state.

A future contributor reading the asymmetry without context will likely "fix" the inconsistency by adding `oc-broadcasting` back. A 2-line comment would prevent that.

## Findings

- `src/pages/Send.tsx` `SendStep` union — `oc-broadcasting` no longer present, `ln-sending` still present.
- Flagged by `architecture-strategist` during PR #147 follow-up review.

## Proposed Solution

Add a comment near the `SendStep` union or near the `isBroadcasting` declaration:

```ts
// On-chain broadcast resolves in sub-second so it's a concurrent button busy
// state, not a step. Lightning sends are seconds-long with their own UI, so
// `ln-sending` remains a discrete step.
```

**Effort:** 2 min.
**Risk:** None.

## Acceptance Criteria

- [ ] Comment exists explaining the `oc-broadcasting`-as-boolean choice.

## Resources

- **PR:** #147
- **Reviewer:** `architecture-strategist`
- **Related:** todo 271

## Work Log

### 2026-04-29 — Surfaced during PR #147 follow-up review
**By:** architecture-strategist
