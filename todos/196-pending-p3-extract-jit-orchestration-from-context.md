---
status: pending
priority: p3
issue_id: '196'
tags: [code-review, architecture, lsps2]
---

# Extract JIT protocol orchestration from React context

## Problem Statement

The `requestJitInvoice` method in `context.tsx` (lines 219-313) contains LSPS2 protocol orchestration logic (fee selection, validity checking, `create_inbound_payment`) that should be in the LSPS2 client layer, not the React context.

## Findings

- **Architecture reviewer recommendation A:** Moving this logic to `LSPS2Client` would reduce the React context's protocol knowledge, make the flow unit-testable without React, and keep `context.tsx` focused on wiring.

## Proposed Solutions

1. **Move orchestration to LSPS2Client** — Create a higher-level method like `LSPS2Client.requestJitInvoice(channelManager, amountMsat, ...)` that encapsulates fee selection, validity checking, payment creation, and invoice encoding.
   - Pros: Better separation of concerns, testable
   - Cons: Client needs channelManager access; more refactoring
   - Effort: Medium
   - Risk: Low

## Technical Details

- **Affected files:** `src/ldk/lsps2/client.ts`, `src/ldk/context.tsx`
- **Effort:** Medium

## Resources

- Branch: feat/lsps2-jit-channel-receive
