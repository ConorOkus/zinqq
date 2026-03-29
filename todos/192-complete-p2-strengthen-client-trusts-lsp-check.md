---
status: complete
priority: p2
issue_id: '192'
tags: [code-review, security, lsps2]
---

# Strengthen client_trusts_lsp type check

## Problem Statement

The `buyChannel` method in `client.ts` checks `trustsLsp === true` but a malicious LSP could send `client_trusts_lsp: "true"` (string), bypassing the strict equality check while semantically requiring trust mode.

## Findings

- **Security sentinel HIGH-2:** Type coercion bypass. `"true" !== true` passes the check, but the intent is violated.
- **Simplicity reviewer finding 6:** The `clientTrustsLsp` field on `BuyResponse` is always `false` after the check passes — it carries no information and should be removed.

## Proposed Solutions

1. **Reject anything that is not explicitly `false`** — Change to `if (trustsLsp !== false) throw`. Remove `clientTrustsLsp` from `BuyResponse` interface.
   - Pros: Airtight; removes dead field
   - Cons: None
   - Effort: Trivial
   - Risk: Low

## Technical Details

- **Affected files:** `src/ldk/lsps2/client.ts` (lines 79-90)
- **Effort:** Trivial

## Acceptance Criteria

- [ ] `client_trusts_lsp` values other than `false` are rejected
- [ ] `clientTrustsLsp` field removed from `BuyResponse`

## Resources

- Branch: feat/lsps2-jit-channel-receive
