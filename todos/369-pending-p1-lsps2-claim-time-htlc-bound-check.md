---
status: pending
priority: p1
issue_id: '369'
tags: [lsps2, jit-receive, security, financial-safety, ldk-event-handler]
dependencies: []
---

# LSPS2 claim-time HTLC bound check still unimplemented (todo 306 "Option C")

## Problem Statement

`accept_underpaying_htlcs(true)` is set wallet-wide (`src/ldk/init.ts:151`), so
LDK will accept an inbound HTLC that pays LESS than the invoice amount with no
lower bound. The Review screen discloses `Setup fee: X` / `You'll receive: Y`
and `executeJitBuy` registers `create_inbound_payment(amountMsat -
openingFeeMsat)` as the expected amount — but nothing enforces that the
**actually-claimed** amount meets that expectation at HTLC time.

`todo 306` was resolved via "Option B" (document + warn only — the
`[LSP] JIT buy committed; HTLC underpayment beyond disclosed fee is not
bound-checked at claim time (todo 306)` log). The real fix ("Option C", the
claim-time bound check) was deferred and **never landed**. Confirmed still open:
`src/ldk/traits/event-handler.ts:213` calls `channelManager.claim_funds(preimage)`
unconditionally in the `PaymentClaimable` handler, with no comparison of
`event.amount_msat` against the expected receive amount.

A malicious or buggy LSP can therefore deduct MORE than the disclosed opening
fee and the wallet will silently claim the smaller amount, making the Review
disclosure a broken promise.

## Findings

- **File**: `src/ldk/traits/event-handler.ts:191-223` (`PaymentClaimable`).
- The expected amount is known at `create_inbound_payment` time
  (`context.tsx` `executeJitBuy`, `expectedReceiveMsat`) but is not threaded to
  the event handler for comparison.

## Proposed Solution

In the `PaymentClaimable` handler, compare `event.amount_msat` against the
expected receive amount recorded for that `payment_hash`; if
`amount_msat < expected`, reject (fail the HTLC) instead of claiming, and
surface a clear error. Requires tracking expected-amount-by-payment-hash
(e.g. a map populated in `executeJitBuy`, read in the handler).

## Acceptance Criteria

- [ ] `PaymentClaimable` rejects/fails HTLCs that pay below the expected
      `amountMsat - openingFeeMsat` (within a defined tolerance).
- [ ] The expected amount is plumbed from `executeJitBuy` to the handler.
- [ ] Unit test: a short-paying HTLC is NOT claimed; an exact/over HTLC is.
- [ ] Remove or downgrade the todo-306 warning once enforced.

## Context

Re-confirmed open while debugging a JIT receive in
`feat/jit-buy-phase-fallback-and-min-receive-gate`. Supersedes the deferred
"Option C" tracked in `todos/306-complete-p1-accept-underpaying-htlcs-hole-documentation.md`.
