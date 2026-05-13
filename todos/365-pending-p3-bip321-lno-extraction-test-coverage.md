---
status: pending
priority: p3
issue_id: '365'
tags: [code-review, tests, bip321, payment-input]
dependencies: []
---

# Add BIP 321 `lno=` extraction test at the URI layer

## Problem Statement

The deleted Payjoin precedence test (`"drops payjoin when lightning= is present"`) was incidentally the only test exercising the multi-param dispatch in `parseBip321()`. After PR #164's removal, the surviving BIP 321 tests cover `amount=`, `lightning=`, malformed `%`, and network mismatch — but **no surviving test asserts that `bitcoin:<addr>?lno=lno1...` routes to `type: 'bolt12'` at the BIP 321 layer**.

BOLT 12 itself is tested via raw `lno1...` strings elsewhere, so the offer parser is covered. But the `parseBip321` branch at the `if (lnoValue)` site is now unverified by integration. A regression that swaps the `lno` / `lightning` branch ordering, or fails to call `parseBolt12Offer(lnoValue)`, would slip past this file's suite.

## Findings

- `src/ldk/payment-input.test.ts` — no surviving test for `bitcoin:<addr>?lno=...`.
- `src/ldk/payment-input.ts:230-234` — `lno` precedence branch uncovered at the URI layer.
- Flagged by `kieran-typescript-reviewer` (P3) during PR #164 review.

## Proposed Solution

Add two tests to the `'classifyPaymentInput — BIP 321 query params'` describe:

1. `bitcoin:<addr>?lno=<valid-offer>` returns `{ type: 'bolt12', ... }`.
2. `bitcoin:<addr>?lno=<valid-offer>&lightning=<valid-invoice>` returns `bolt12` (precedence: BOLT 12 > BOLT 11).

Use the same offer fixture pattern as the standalone BOLT 12 tests.

**Effort:** Small.
**Risk:** None.

## Recommended Action

To be filled during triage.

## Technical Details

**Affected files:** `src/ldk/payment-input.test.ts`.

## Acceptance Criteria

- [ ] Test asserts `lno=` routes to `bolt12` at the BIP 321 layer.
- [ ] Test asserts `lno` beats `lightning` when both are present.

## Resources

- **PR:** #164
- **Reviewer:** `kieran-typescript-reviewer`

## Work Log

### 2026-05-13 — Surfaced during PR #164 review

**By:** kieran-typescript-reviewer
