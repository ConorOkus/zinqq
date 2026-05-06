---
status: pending
priority: p2
issue_id: '315'
tags: [code-review, architecture, types, pr-150]
dependencies: []
---

# Tagged-result for `getJitQuote` instead of error-carrying-payload

## Problem Statement

`JitPaymentSizeOutOfRangeError` carries `menu: OpeningFeeParams[]` and `contact: LspContact` fields. This uses `throw` as a multi-return — the caller catches the error and extracts the payload to render the "Minimum receive" affordance. Errors should communicate exceptional conditions; below-minimum is a normal, expected outcome of a valid LSPS2 quote phase. Make `getJitQuote` return a tagged result type so below-minimum is a value, not an exception.

## Findings

- **File**: `src/ldk/context.tsx:73-86` (error class with payload)
- **File**: `src/pages/Receive.tsx:200-212` (catches error, extracts payload, transitions state)
- **Identified by**: code-simplicity-reviewer (#7), architecture-strategist (#5 — boundary OK but value-shape preferable)
- The pattern conflicts with the simpler "errors are exceptional" idiom; the existing failover orchestration in `runJitQuoteFlow` uses `instanceof JitPaymentSizeOutOfRangeError` to decide failover

## Proposed Solutions

### Option A: Tagged result type from `getJitQuote` (Recommended)

```ts
type JitQuoteOutcome =
  | JitQuote
  | { kind: 'below-minimum'; menu: OpeningFeeParams[]; contact: LspContact }
async function getJitQuote(...): Promise<JitQuoteOutcome>
```

- `runJitQuoteFlow` branches on `'kind' in result` to decide failover vs. surface to caller
- `Receive.tsx` checks the tag rather than `instanceof`
- Keep `JitPeerConnectError` and `JitQuoteFreshnessError` — those are genuinely exceptional
- **Pros**: Below-minimum is a value, not an exception; failover logic reads more cleanly
- **Cons**: `runJitQuoteFlow`'s loop logic gets a new branch; signature changes
- **Effort**: Small-Medium

### Option B: Keep error-class-with-payload, add a comment

- Document the convention (errors-as-multi-return for "below-minimum") at the class definition
- **Pros**: Minimal change
- **Cons**: Smell remains; new contributors won't know the convention
- **Effort**: Tiny

## Recommended Action

(Filled during triage — Option A)

## Technical Details

- **Affected files**: `src/ldk/context.tsx`, `src/pages/Receive.tsx`, `src/ldk/lsp/jit-failover.test.ts`, `src/pages/Receive.test.tsx`

## Acceptance Criteria

- [ ] `getJitQuote` returns a discriminated union including `'below-minimum'`
- [ ] `runJitQuoteFlow` branches on the tag (failover continues only on actual failures)
- [ ] `Receive.tsx` consumes the tagged outcome without `instanceof`
- [ ] Existing tests updated; below-minimum scenario still passes
- [ ] `pnpm test` and `pnpm lint` pass

## Work Log

(Empty)

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/150
