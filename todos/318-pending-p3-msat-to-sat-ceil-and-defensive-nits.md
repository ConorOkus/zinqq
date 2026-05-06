---
status: pending
priority: p3
issue_id: '318'
tags: [code-review, simplicity, dry, pr-150]
dependencies: []
---

# `msatToSatCeil` helper + minor defensive nits

## Problem Statement

A handful of low-priority polish items from the PR #150 review pass:

1. **`(x + 999n) / 1000n` repeated 3x** — extract `msatToSatCeil` next to the existing `msatToSatFloor` (`src/utils/msat.ts`).
2. **`Receive.tsx:469` `requestAnimationFrame(() => setConfirmedAmountDigits(prev))`** — see todo 313 for the full fix; this is the same item.
3. **`buyControllerRef.current?.abort()` in `handleReviewBack`** for defensive symmetry — Back is currently hidden during `'jit-buying'`, but a defensive abort would prevent a late `.then` from painting over the numpad if the invariant ever changes.
4. **Inline comment at `executeJitBuy:325`** documenting that `signal` is intentionally not propagated into `buyChannel` / `createJitInvoice`.
5. **`executeJitBuyCallback` rename** — drop the `Callback` suffix, or rename context to `requestJitBuy` for symmetry with `requestJitQuote`.
6. **`getJitQuote` connect-retry** — early-return on `signal.aborted` at the top of the retry block (one extra connect after Back is currently possible).
7. **`AbortError` early-return in main effect's `.catch`** — generic AbortError currently silently degrades to on-chain (`Receive.tsx:208`); should early-return without changing state.
8. **Pre-warm debounce window** — security-sentinel suggested 600-800ms (currently 300ms) to reduce LSP RPC pressure during numpad mashing. Marginal; revisit if telemetry shows abuse.
9. **`receiveState.amountSats === quote.amountMsat` assertion** in `handleGenerateInvoice` — defense-in-depth that they can't drift.
10. **Unit test for `buyControllerRef` invariant** — dispatch buy, fire Back during the await, assert `setInvoice` is NOT called.

## Findings

- All identified by various reviewers in PR #150 review pass: kieran-typescript-reviewer, code-simplicity-reviewer, security-sentinel (P2-B, P3-A, P3-B), architecture-strategist
- All low-impact / defensive / DRY items

## Proposed Solutions

Pick from the list as time allows. None block merge.

## Recommended Action

(Filled during triage — likely batch as a single follow-up commit before merge)

## Technical Details

- **Affected files**: `src/utils/msat.ts`, `src/pages/Receive.tsx`, `src/ldk/context.tsx`, `src/pages/Receive.test.tsx`

## Acceptance Criteria

- [ ] At least items 1, 4, 7 addressed (DRY + correctness)
- [ ] `pnpm test` and `pnpm lint` pass

## Work Log

(Empty)

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/150
