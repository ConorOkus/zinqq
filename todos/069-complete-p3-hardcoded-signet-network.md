---
status: pending
priority: p3
issue_id: "069"
tags: [code-review, quality]
dependencies: []
---

# Hardcoded 'signet' network in send context helpers

## Problem Statement

`Address.from_string(address, 'signet')` is hardcoded in 4 places across estimateFee, estimateMaxSendable, sendToAddress, and sendMax. Consistent with existing code (init.ts also hardcodes 'signet'), but creates coupling points for future multi-network support.

## Findings

**Location:** `src/onchain/context.tsx`, lines 111, 140, 171, 215

Flagged by: kieran-typescript-reviewer, architecture-strategist

## Proposed Solutions

### Option A: Add network to ONCHAIN_CONFIG
Add `network: 'signet'` to config.ts and reference it everywhere.

- Effort: Small
- Risk: Low

## Acceptance Criteria

- [ ] Network string comes from a single config source
- [ ] All Address.from_string calls use the config value
