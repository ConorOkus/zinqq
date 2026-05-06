---
status: pending
priority: p1
issue_id: '306'
tags: [code-review, security, lsps2, pr-150, financial-safety]
dependencies: []
---

# `accept_underpaying_htlcs` is unbounded; document the hole + warn at `executeJitBuy`

## Problem Statement

`accept_underpaying_htlcs(true)` is set wallet-wide in `createUserConfig` (`src/ldk/init.ts:151`). With this flag, LDK accepts HTLCs that pay LESS than the invoice amount without bound. The Review screen displays `Setup fee: ₿X` and `You'll receive: ₿Y`, registering the inbound payment with `expectedReceiveMsat = invoiceAmountMsat - openingFeeMsat`. **However**, a malicious or buggy LSP can deduct MORE than the disclosed `openingFeeMsat` at HTLC time and the wallet will silently mark the payment received — making the Review's disclosure a lie.

The plan deferred the explicit `claimable_amount_msat ≥ expected_msat` event-handler bound check to PR 2. This PR ships without it. The hole is not new (it pre-dates this PR), but the new Review screen makes the disclosure user-facing and therefore an actively-broken promise rather than an invisible internal mismatch.

## Findings

- **File**: `src/ldk/init.ts:151`, `src/ldk/context.tsx:316-322`
- **Identified by**: security-sentinel (P1-B)
- The comment at `context.tsx:316-319` claims `expectedReceiveMsat` makes LDK reject grossly underpaid HTLCs — this is misleading given `accept_underpaying_htlcs=true`
- PR 2 is scoped to add the claim-time bound check in the LDK event handler

## Proposed Solutions

### Option A: Land PR 2's claim-time bound check before merging this PR

- Invert the order: ship the event-handler bound enforcement first, then the Review screen
- **Pros**: Closes the hole before exposing the disclosure UI
- **Cons**: Reorders work; PR 2 has more scope (stale-quote, retry, lifecycle)
- **Effort**: Medium

### Option B: Add minimal claim-time check + WARN in this PR (Recommended for this PR's scope)

- Add a `console.warn` in `executeJitBuy` when called: `[Receive] LSPS2 buy committed; HTLC underpayment beyond openingFeeMsat is currently not enforced by the event handler — see todo 306`
- Update the misleading comment at `context.tsx:316-319` to explicitly say the claim-time bound is NOT enforced today
- Document the hole prominently in the PR description (already partial — make it explicit with a link to PR 2's tracker)
- **Pros**: Visible in incident reviews; correct doc; small change
- **Cons**: The hole stays open until PR 2
- **Effort**: Small

### Option C: Pre-empt PR 2 — add the bound check in this PR

- Modify the LDK event handler's `PaymentClaimable` handler to compare `claimable_amount_msat` against the `expected_msat` recorded at `create_inbound_payment` time, reject if delta > 0
- **Pros**: Closes the hole now
- **Cons**: Creeps into PR 2's scope; needs its own tests; harder to review alongside the Review-screen change
- **Effort**: Medium-Large

## Recommended Action

(Filled during triage — leaning Option B for this PR + Option C as PR 2)

## Technical Details

- **Affected files**: `src/ldk/init.ts`, `src/ldk/context.tsx`, eventually `src/ldk/traits/event-handler.ts`
- **Components**: LSPS2 buy, LDK event handler

## Acceptance Criteria

- [ ] `console.warn` (or equivalent log) at `executeJitBuy` call site documenting the gap
- [ ] Comment at `context.tsx:316-319` rewritten to say claim-time bound is NOT enforced
- [ ] PR description has a prominent "Known limitation" section with link to PR 2
- [ ] OR (Option C): `PaymentClaimable` handler enforces `claimable_amount_msat ≥ expected_msat`, rejects otherwise, with a unit test

## Work Log

(Empty)

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/150
- Plan section: "Phase 5: Phase B retry + HTLC fee-bound enforcement"
- Solutions doc: `docs/solutions/integration-issues/lsps2-jit-receive-channel-config.md`
- Solutions doc: `docs/solutions/integration-issues/ldk-event-handler-multi-lsp-trust-set.md`
