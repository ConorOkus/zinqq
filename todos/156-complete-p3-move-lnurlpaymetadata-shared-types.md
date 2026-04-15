---
status: complete
priority: p3
issue_id: '156'
tags: [code-review, architecture]
dependencies: []
---

# Move LnurlPayMetadata to shared types location

## Problem Statement

`src/ldk/payment-input.ts` imports `LnurlPayMetadata` from `src/lnurl/resolve-lnurl.ts`, creating an inverted dependency (ldk/ depends on lnurl/). The type should live in a shared location.

**Files:** `src/ldk/payment-input.ts` line 13, `src/lnurl/resolve-lnurl.ts` line 1

## Proposed Solutions

Move `LnurlPayMetadata` interface to a shared types file (e.g., `src/types/payment.ts` or alongside `ParsedPaymentInput`). Both `resolve-lnurl.ts` and `payment-input.ts` import from there.

- Effort: Small
- Risk: None

## Acceptance Criteria

- [ ] `LnurlPayMetadata` in a shared location
- [ ] No inverted dependency from ldk/ to lnurl/
