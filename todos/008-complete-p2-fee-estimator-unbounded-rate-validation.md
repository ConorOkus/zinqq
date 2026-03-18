---
status: complete
priority: p2
issue_id: "008"
tags: [code-review, security, input-validation]
dependencies: []
---

# Fee estimator accepts unbounded rates from Esplora API

## Problem Statement

`createFeeEstimator` in `src/ldk/traits/fee-estimator.ts` parses Esplora's `/fee-estimates` JSON response and uses `feePerVbyte` values directly after conversion. There is a floor of 253 sat/KW but no ceiling and no type validation. A compromised or malfunctioning Esplora API could return extremely high values (causing massive fee overpayment) or non-numeric values (NaN propagation).

## Acceptance Criteria

- [ ] `typeof` and `Number.isFinite()` check on each `feePerVbyte` before use
- [ ] Upper-bound cap (e.g., 500,000 sat/KW / ~2,000 sat/vB)
- [ ] Invalid entries are skipped, not silently converted to NaN
