---
status: complete
priority: p3
issue_id: '164'
tags: [code-review, architecture]
dependencies: []
---

# Extract buildBip21Uri utility from Receive.tsx

## Problem Statement

The BIP 21 URI construction logic is inline in `Receive.tsx` (lines 88-100). Extracting it as a `buildBip21Uri({ address, amountSats?, invoice? })` function alongside `parseBip21` in `src/onchain/bip21.ts` would make it reusable and testable independently.

**File:** `src/pages/Receive.tsx` lines 88-100, `src/onchain/bip21.ts`

## Findings

- Flagged by architecture strategist and agent-native reviewer
- `parseBip21` already exists as a standalone utility; the builder is its natural complement
- Would make Receive.tsx thinner and enable future agent/service layer reuse

## Acceptance Criteria

- [ ] `buildBip21Uri` exported from `src/onchain/bip21.ts`
- [ ] Receive.tsx calls the utility instead of inline construction
- [ ] Unit tests for buildBip21Uri with and without amount/invoice
