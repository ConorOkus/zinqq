---
status: pending
priority: p2
issue_id: '313'
tags: [code-review, simplicity, react, pr-150]
dependencies: []
---

# Replace `handleErrorRetry`'s `requestAnimationFrame` hack with an explicit transition

## Problem Statement

`handleErrorRetry` clears `confirmedAmountDigits` and then re-sets it via `requestAnimationFrame` to re-trigger the main `useEffect`. This is a code smell — using state churn to drive an effect re-run reads as "I'm afraid of the dependency graph." There's a cleaner path: an explicit state transition that the main effect keys on directly, or an extracted `startQuote()` callable from both the initial path and the retry handler.

## Findings

- **File**: `src/pages/Receive.tsx:465-470`
- **Identified by**: kieran-typescript-reviewer, code-simplicity-reviewer (#5)
- The rAF dance is fragile — if React batches the two state updates differently, the effect may not re-run

## Proposed Solutions

### Option A: Extract `startQuote()` callable and call it from both paths (Recommended)

- Pull the Phase A initiation into a function that takes `amountMsat` and the controller setup
- Call from the main effect AND from the retry handler
- **Pros**: Single source of truth for "start quote"; effect logic simplifies; rAF hack gone
- **Cons**: Slight refactor of the main effect
- **Effort**: Small

### Option B: Add a `retryNonce: number` state field; the retry handler increments it; main effect depends on it

- Same effect structure, just a real signal instead of state-churn
- **Pros**: Minimal change
- **Cons**: Still effect-driven; retry nonce is a smell
- **Effort**: Tiny

### Option C: Direct transition `setReceiveState({ step: 'jit-quoting' })` + key main effect on step

- Add `receiveState.step` to the effect deps
- **Pros**: No new state; the state machine drives itself
- **Cons**: Effect deps grow, race risk with the cleanup function
- **Effort**: Tiny

## Recommended Action

(Filled during triage — likely Option A)

## Technical Details

- **Affected files**: `src/pages/Receive.tsx`

## Acceptance Criteria

- [ ] `requestAnimationFrame` hack removed from `handleErrorRetry`
- [ ] Retry path is explicit (extracted callable or named transition)
- [ ] `pnpm test` and `pnpm lint` pass
- [ ] The retry test in `Receive.test.tsx` still passes (or is updated to match the new mechanism)

## Work Log

(Empty)

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/150
