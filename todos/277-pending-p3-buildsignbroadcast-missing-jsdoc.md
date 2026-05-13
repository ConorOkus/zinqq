---
status: pending
priority: p3
issue_id: '277'
tags: [code-review, docs, onchain]
dependencies: []
---

# `buildSignBroadcast` lacks a docstring for its non-obvious lifecycle

## Problem Statement

`buildSignBroadcast` does meaningful non-obvious work — pause sync → fee floor check → MAX_FEE_SATS sanity → sign → broadcast → balance update → persist changeset → resume sync — and has no docstring. Three callers (`sendToAddress`, both `sendMax` codepaths) rely on the lifecycle, so a future reader needs to chase each step manually.

## Findings

- `src/onchain/context.tsx:170-174` (post-PR #147) — bare function, no JSDoc.
- Three callers (`sendToAddress`, both `sendMax` codepaths) rely on the lifecycle.
- Flagged by `kieran-typescript-reviewer` as P3.

## Proposed Solution

Add a one-paragraph JSDoc:

```ts
/**
 * Build a PSBT, fee-sanity-check it, sign, broadcast, then persist BDK
 * changeset and resume sync. Pauses the sync loop while in flight so a
 * concurrent sync doesn't race the just-built tx. Throws are mapped via
 * `mapSendError` for friendlier user-facing messages.
 */
```

**Effort:** 5 min.

**Risk:** None.

## Recommended Action

To be filled during triage.

## Technical Details

**Affected files:** `src/onchain/context.tsx`.

## Acceptance Criteria

- [ ] `buildSignBroadcast` has a JSDoc that describes the lifecycle without referencing Payjoin.

## Resources

- **PR:** #147
- **Reviewer:** `kieran-typescript-reviewer`

## Work Log

### 2026-04-29 — Surfaced during PR #147 review

**By:** kieran-typescript-reviewer
