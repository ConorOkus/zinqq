---
status: pending
priority: p3
issue_id: '284'
tags: [code-review, ux, onchain]
dependencies: []
---

# `mapSendError` no longer formats `InsufficientFunds` on the rare unmapped path

## Problem Statement

Todo 272 removed the `InsufficientFunds` import + branch from `mapSendError` because `sendToAddress`'s explicit anchor-reserve + `estimateFee` pre-check makes the BDK throw unreachable. That's true for `sendToAddress`, but `sendMax`'s no-channels path (`context.tsx`) calls `buildSignBroadcast` via the drain-wallet builder without an explicit balance pre-check — a user racing a sync could still trigger the BDK throw, which now surfaces the raw BDK message instead of the previous formatted `Available: x BTC, needed: y BTC`.

This is an exceedingly rare path — kieran labeled it "minor." Filing as P3 to preserve the option of a string-match fallback.

## Findings

- `src/onchain/context.tsx:53-66` (post-PR #147) — `mapSendError` no longer recognizes `InsufficientFunds`.
- `src/onchain/context.tsx` `sendMax` no-channels branch — drains wallet without an explicit balance pre-check.
- Flagged by `kieran-typescript-reviewer` as a minor UX observation.

## Proposed Solution

Add a substring-match fallback to `mapSendError`:

```ts
if (msg.includes('insufficient')) {
  return new Error('Insufficient on-chain balance to cover this send + fee')
}
```

No need to re-import `InsufficientFunds` — the substring match keeps the type surface narrow.

**Effort:** 5 min.
**Risk:** None.

## Acceptance Criteria

- [ ] An `InsufficientFunds`-style message from BDK surfaces a user-friendly string.

## Resources

- **PR:** #147
- **Reviewer:** `kieran-typescript-reviewer`
- **Related:** todo 272

## Work Log

### 2026-04-29 — Surfaced during PR #147 follow-up review
**By:** kieran-typescript-reviewer
