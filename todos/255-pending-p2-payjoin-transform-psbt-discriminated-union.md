---
status: pending
priority: p2
issue_id: '255'
tags: [code-review, payjoin, architecture, type-safety]
dependencies: []
---

# `TransformPsbtHook` should return a discriminated union, not rely on identity comparison

## Problem Statement

`context.tsx:215` decides whether to run `wallet.apply_unconfirmed_txs` based on `result !== original` — i.e., object identity. `tryPayjoinSend` (`payjoin.ts:149-151`) returns `unsigned` for the kill-switch path so identity holds.

But PDK doesn't promise identity preservation. If a future PDK version returns a fresh `Psbt` instance even for a no-op proposal, the validator would pass and `wasTransformed` would be `false`, skipping the apply. The "unchanged proposal" test (`proposal-validator.test.ts:843-857`) currently passes only because it reuses the same fixture object.

## Findings

- **architecture-strategist #3**: identity comparison is fragile load-bearing logic. Two separate behaviors (telemetry signaling and BDK reapply branch) hinge on it.
- **architecture-strategist #1**: the `wasTransformed` boolean leaks Payjoin semantics into a generic helper.

## Proposed Solutions

### Option 1 (recommended) — Discriminated union

```ts
// onchain-context.ts
export type TransformPsbtResult =
  | { kind: 'declined' } // sign original, no foreign-built reapply
  | { kind: 'transformed'; psbt: Psbt } // sign this, foreign-built — reapply

export type TransformPsbtHook = (
  unsigned: Psbt,
  ctx: { wallet: Wallet; feeRate: bigint } // signal removed per todo #253
) => Promise<TransformPsbtResult>
```

`tryPayjoinSend` returns `{ kind: 'declined' }` for kill-switch, throws `PayjoinFallback` for everything else. `buildSignBroadcast` reads `result.kind === 'transformed'` — explicit and unambiguous.

Rename `wasTransformed` to `psbtIsForeignBuilt` and rewrite the comment generically (it isn't Payjoin-specific — any future foreign-builder hook benefits).

- Pros: kills identity-comparison fragility; comment becomes generic; new hook authors get an unambiguous signal.
- Cons: small API churn — but only one consumer today.

### Option 2 — Document and accept

Leave the identity comparison; document the assumption ("PDK MUST return the same Psbt instance for kill-switch / unchanged proposals").

- Pros: zero code change.
- Cons: documentation can't enforce upstream behavior.

## Recommended Action

Option 1. The hook is new; refactoring it now costs less than later.

## Technical Details

- Affected files:
  - `src/onchain/onchain-context.ts` — `TransformPsbtHook` type + new `TransformPsbtResult` type
  - `src/onchain/context.tsx` — `buildSignBroadcast` consumes `result.kind`
  - `src/onchain/payjoin/payjoin.ts` — return shape changes
  - `src/onchain/payjoin/payjoin.test.ts` — update fixture expectations
  - `src/pages/Send.tsx` — closure construction
- Bundle with todo #253 (drop `signal` parameter) since both touch the same hook signature.

## Acceptance Criteria

- [ ] `TransformPsbtResult` exported
- [ ] `tryPayjoinSend` returns `{ kind: 'declined' }` on kill switch, throws otherwise
- [ ] `buildSignBroadcast` no longer compares object identity
- [ ] All payjoin tests pass with updated fixtures

## Work Log

## Resources

- PR #143
- architecture-strategist agent report for PR #143
