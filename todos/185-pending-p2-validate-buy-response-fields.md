---
status: pending
priority: p2
issue_id: '185'
tags: [code-review, security, lsps2]
---

# Validate lsps2.buy response fields

## Problem Statement

The `buyChannel` method in `client.ts` uses TypeScript `as` casts on the LSP JSON-RPC response without runtime validation. `lsp_cltv_expiry_delta` could be missing/NaN, `jit_channel_scid` could be malformed. Also applies to `get_info` response shape.

## Findings

- TS reviewer: HIGH - `as` casts on untrusted LSP responses bypass type safety
- Security sentinel: MEDIUM - malicious LSP could inject bad values

## Proposed Solutions

1. Add validation functions similar to `deserializeOpeningFeeParams` for each response shape
2. Validate SCID ranges in `parseLsps2Scid` (block < 2^24, tx < 2^24, output < 2^16)
3. Validate CLTV delta is a positive integer

## Technical Details

- **Affected files:** `src/ldk/lsps2/client.ts`, `src/ldk/lsps2/bolt11-encoder.ts`
- **Effort:** Small

## Acceptance Criteria

- [ ] `typeof` checks for all response fields before use
- [ ] SCID range validation in `parseLsps2Scid`
- [ ] Positive integer check for CLTV delta

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/60
