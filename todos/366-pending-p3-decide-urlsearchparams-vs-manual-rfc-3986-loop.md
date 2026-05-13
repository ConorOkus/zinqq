---
status: pending
priority: p3
issue_id: '366'
tags: [code-review, simplicity, bip321, payment-input]
dependencies: []
---

# Decide: keep manual RFC 3986 loop in `parseBip321`, or collapse to `URLSearchParams`

## Problem Statement

`parseBip321()` (`src/ldk/payment-input.ts:208-227`) hand-rolls a `split('&')` + `decodeURIComponent` loop instead of using `URLSearchParams`. The original justification was Payjoin: `pj=`'s value carried literal `+` bytes (BIP 77 v2 fragment separator) that `URLSearchParams` would have decoded to spaces.

After PR #164's Payjoin removal, the surviving params are:

- `lno=` — bech32m offer; alphabet `[02-9ac-hj-np-z]`, no `+`.
- `lightning=` — bech32 invoice; same alphabet, no `+`.
- `amount=` — decimal digits + `.`, no `+`.

**None of the surviving params need `+`-preservation.** The manual loop is now arguably over-engineered.

Two defensible directions:

1. **Simplify to `URLSearchParams`.** Smaller code, idiomatic, standard semantics. Risk: if a _future_ query param ever needs to carry a literal `+`, the bug returns silently.
2. **Keep the manual loop.** Defensive against future param additions. Cost: ~15 lines of bespoke parsing for behavior that no current consumer needs.

Both are reasonable. Worth an explicit decision rather than letting drift settle it.

## Findings

- `src/ldk/payment-input.ts:208-227` — hand-rolled loop, original Payjoin justification gone.
- `code-simplicity-reviewer` flagged as P2 during PR #164 review.
- Related: todo #276 (cancelled in PR #164) — would have added a rationale comment for keeping the loop. Cancelled pending this decision.

## Proposed Solutions

### Option A — Collapse to `URLSearchParams`

```ts
const params = new URLSearchParams(queryPart)
const lnoValue = params.get('lno')
const lightningValue = params.get('lightning')
const amountBtc = params.get('amount')
```

Drop the malformed-`%` error path (URLSearchParams silently ignores those, which is a behavior change — see test at `payment-input.test.ts:169-178`). Either accept the new behavior or replicate the strict-rejection path explicitly.

- **Pros:** ~15 lines smaller, idiomatic, standard semantics.
- **Cons:** Behavior change on malformed `%`-escapes; loses `+`-preservation if ever needed; case-insensitivity for keys (the current loop lowercases keys; URLSearchParams does not).
- **Effort:** Small.

### Option B — Keep manual loop, add rationale comment

Add a 2-line comment explaining the loop preserves literal `+` for any future param that needs RFC 3986 semantics.

- **Pros:** Future-proofs, preserves case-insensitive key matching and strict `%`-rejection.
- **Cons:** Keeps unused complexity; comment may rot.
- **Effort:** Trivial.

## Recommended Action

To be filled during triage. Lean: Option B (keep + comment) since the cost is negligible and the protection is real for future params.

## Technical Details

**Affected files:** `src/ldk/payment-input.ts`, possibly `src/ldk/payment-input.test.ts` (if Option A changes malformed-`%` behavior).

## Acceptance Criteria

- [ ] Decision recorded.
- [ ] Code matches decision: either simplified loop or annotated loop.
- [ ] Test suite still passes.

## Resources

- **PR:** #164
- **Reviewer:** `code-simplicity-reviewer`
- **Related:** todo #276 (cancelled, waiting on this decision)

## Work Log

### 2026-05-13 — Surfaced during PR #164 review

**By:** code-simplicity-reviewer
