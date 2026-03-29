---
status: complete
priority: p2
issue_id: '191'
tags: [code-review, security, lsps2]
---

# Inbound payment created with no amount enforcement

## Problem Statement

`create_inbound_payment` is called with `Option_u64Z_None` (no amount) to work around LSP fee deduction. This means LDK will accept any amount for this payment hash — including amounts far less than expected. A malicious LSP could forward a tiny fraction of the original payment.

## Findings

- **Security sentinel HIGH-1:** Potential underpayment attack. Invoice says X sats but user could receive far less without error.
- **Architecture reviewer R5:** This is an inherent LSPS2 trade-off since the LSP deducts fees before forwarding. The code comment at context.tsx:272-273 explains the rationale.

## Proposed Solutions

1. **Pass expected post-fee amount with tolerance** — Calculate `amountMsat - openingFeeMsat` and pass to `create_inbound_payment` with a small tolerance margin (e.g., 1% below expected).
   - Pros: LDK rejects grossly underpaid HTLCs
   - Cons: Needs careful tolerance tuning; LSP fee may vary slightly from estimate
   - Effort: Small
   - Risk: Medium (too tight = rejected payments)

2. **Validate in PaymentClaimable event** — Check the claimed amount against the expected amount in the event handler before calling `claim_funds`.
   - Pros: More flexible, doesn't risk rejecting valid payments
   - Cons: More complex; needs state to track expected amounts
   - Effort: Medium
   - Risk: Low

3. **Accept the trade-off (document only)** — Add a comment documenting the risk and deferring to mainnet hardening.
   - Pros: No code change
   - Cons: Risk remains
   - Effort: Trivial
   - Risk: Unchanged

## Technical Details

- **Affected files:** `src/ldk/context.tsx` (lines 274-278)
- **Effort:** Small-Medium

## Acceptance Criteria

- [ ] Underpayment below a reasonable threshold is rejected
- [ ] Valid LSPS2 payments (with fee deduction) still succeed
- [ ] Trade-off is documented in code comments

## Resources

- Branch: feat/lsps2-jit-channel-receive
