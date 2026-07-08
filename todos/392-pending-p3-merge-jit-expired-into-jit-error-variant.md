---
status: pending
priority: p3
issue_id: '392'
tags: [code-review, receive, state-machine, simplification, pr-168]
dependencies: ['389']
---

# `jit-expired` branch near-duplicates `jit-error`; `retryStep` discriminant now inconsistent

## Problem Statement

The new `jit-expired` render branch is a near-copy of `jit-error`: the two-button footer is
byte-identical except the CTA label, and both wire the same handlers. Meanwhile the state
machine now has two shapes for "terminal, retryable" — `jit-error` carries a `retryStep`
discriminant (which is write-only, never read) and `jit-expired` omits it.

## Findings

- Duplication: `src/pages/Receive.tsx:749-786` (`jit-expired`) vs `:787-823` (`jit-error`);
  only icon, title, body copy, and CTA label differ. Both use `handleErrorRetry` +
  `handleReviewBack`.
- A fourth `showHeaderCopy` exclusion was added at `:584`.
- `retryStep` is constructed at `:423/:444/:491` and never read (pre-existing).
- code-simplicity-reviewer: variant merge worth doing; extracting a shared component is
  premature (the file's style is large inline branches; only two call sites).

## Proposed Solutions

### Option A (recommended): Make expiry a variant of the error state

`{ step: 'jit-error'; cause: 'failed' | 'expired' }`, vary icon/title/copy/CTA inside the
one branch; drop the now-unread `retryStep` from the union entirely. Saves ~30 LOC and one
`showHeaderCopy` exclusion. Effort: Small. Risk: low — update the expired-flow test's
queries.

### Option B: Keep both branches, just align the discriminant

Drop `retryStep` (or add it to both). Minimum churn, keeps the duplication. Effort: Trivial.

## Recommended Action

(Triage) Coordinate with todo 389 — if freshness errors get routed to a re-quote instead of
an error screen, the `cause` variant may serve both.

## Technical Details

- **Affected files**: `src/pages/Receive.tsx`, `src/pages/Receive.test.tsx`.

## Acceptance Criteria

- [ ] One render branch serves both failed and expired terminal states (or discriminants are
      consistent if branches are kept).
- [ ] `retryStep` is either read somewhere or removed.
- [ ] Expired-flow and error-flow tests pass.

## Work Log

- 2026-07-08: Filed from `/ce:review` of PR #168 (code-simplicity-reviewer +
  architecture-strategist).
