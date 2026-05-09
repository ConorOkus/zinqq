---
status: pending
priority: p3
issue_id: '361'
tags: [code-review, refactor, fee-estimator, fix-lqwd-channel-acceptance]
dependencies: []
---

# Extract `LDK_ABSOLUTE_MIN_SAT_KW = 253` constant in `fee-estimator.ts`

## Problem Statement

After this branch, `MinAllowedAnchorChannelRemoteFee` and `MinAllowedNonAnchorChannelRemoteFee` are both literal `253` (`fee-estimator.ts:16,22`). The same number also appears as a fallback in `computeFeeRateSatKw` at `:66`:

```ts
return Math.max(satKw, DEFAULT_FEE_RATES[confirmation_target] ?? 253, 253)
```

If the values are intentionally identical (LDK's absolute minimum), name the constant so the intent — and the future divergence point if anchors get a higher floor again — is explicit.

## Findings

- kieran-typescript-reviewer P3

## Proposed Solutions

```ts
// LDK enforces a hard 253 sat/kW (1 sat/vB) floor — going below this
// would be rejected by the channel state machine itself.
const LDK_ABSOLUTE_MIN_SAT_KW = 253

const DEFAULT_FEE_RATES: Record<ConfirmationTarget, number> = {
  // ...
  [ConfirmationTarget.LDKConfirmationTarget_MinAllowedAnchorChannelRemoteFee]:
    LDK_ABSOLUTE_MIN_SAT_KW,
  [ConfirmationTarget.LDKConfirmationTarget_MinAllowedNonAnchorChannelRemoteFee]:
    LDK_ABSOLUTE_MIN_SAT_KW,
  // ...
}

// in computeFeeRateSatKw:
return Math.max(
  satKw,
  DEFAULT_FEE_RATES[confirmation_target] ?? LDK_ABSOLUTE_MIN_SAT_KW,
  LDK_ABSOLUTE_MIN_SAT_KW
)
```

- Pros: Intent visible at a glance; one place to change if LDK ever raises the floor.
- Effort: Small.
- Risk: None.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/traits/fee-estimator.ts:13-22, 66`

## Acceptance Criteria

- [ ] Constant defined and reused in all three sites
- [ ] Tests still pass

## Work Log

_(empty)_

## Resources

- Branch: `fix/lqwd-channel-acceptance`
