---
status: pending
priority: p2
issue_id: "067"
tags: [code-review, quality]
dependencies: []
---

# Balance check inconsistency between UI and context

## Problem Statement

The UI validates amount against `balance.confirmed` only (Send.tsx line 114), but `estimateMaxSendable` computes available balance as `confirmed + trusted_pending` (context.tsx lines 150-151). This means a user with pending balance could be blocked from manually entering an amount that "Send Max" would allow.

## Findings

**Location:**
- `src/pages/Send.tsx`, line 114: `if (amountSats > onchain.balance.confirmed)`
- `src/onchain/context.tsx`, lines 150-151: `confirmed.to_sat() + trusted_pending.to_sat()`

Flagged by: security-sentinel

## Proposed Solutions

### Option A: Align to confirmed + trusted_pending
Use the same balance calculation in both places.

- Effort: Small
- Risk: Low

## Acceptance Criteria

- [ ] Amount validation uses the same balance components as BDK coin selection
- [ ] Or explicitly document that only confirmed balance is spendable in manual mode
