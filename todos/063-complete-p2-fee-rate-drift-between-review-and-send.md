---
status: pending
priority: p2
issue_id: "063"
tags: [code-review, security]
dependencies: []
---

# Fee rate can change between review and broadcast

## Problem Statement

`estimateFee` and `sendToAddress` each independently call `getFeeRate()`. The user reviews a fee at one rate, but the actual transaction may use a different rate if mempool conditions change between review and confirmation.

## Findings

**Location:** `src/onchain/context.tsx` — estimateFee (line 110) and sendToAddress (line 170) both call getFeeRate independently.

The MAX_FEE_SATS cap provides an upper bound, but the fee could still differ significantly from what was reviewed.

Flagged by: security-sentinel

## Proposed Solutions

### Option A: Pass reviewed fee rate to send functions (Recommended)
Add `feeRateSatVb` parameter to `sendToAddress` and `sendMax` so the confirmed rate is used.

- Pros: User pays exactly the fee they reviewed
- Cons: Slightly larger API surface
- Effort: Small
- Risk: Low

## Acceptance Criteria

- [ ] sendToAddress and sendMax accept an optional feeRate parameter
- [ ] If provided, the passed fee rate is used instead of fetching a new one
- [ ] Review step's fee rate is passed through on confirm
