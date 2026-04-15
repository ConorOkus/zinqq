---
status: complete
priority: p3
issue_id: '195'
tags: [code-review, quality, lsps2]
---

# Add BOLT11 cross-validation test with reference decoder

## Problem Statement

The BOLT11 encoder tests verify internal consistency but never decode the produced invoice with a reference implementation. For a wallet handling funds, a malformed invoice means lost payments.

## Findings

- **TS reviewer finding 3:** Tests verify round-trip and format prefix but don't decode with `bolt11` npm package or LDK's decoder to verify payment hash, secret, amount, route hints, and signature survive.

## Proposed Solutions

1. **Add test using `light-bolt11-decoder` or similar** — Decode the test invoice output and assert all fields match input.
   - Effort: Small
   - Risk: Low

## Technical Details

- **Affected files:** `src/ldk/lsps2/bolt11-encoder.test.ts`
- **Effort:** Small

## Acceptance Criteria

- [ ] At least one test decodes a generated invoice with an independent decoder
- [ ] Payment hash, secret, amount, route hints, and signature are verified

## Resources

- Branch: feat/lsps2-jit-channel-receive
