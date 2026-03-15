---
status: pending
priority: p2
issue_id: "068"
tags: [code-review, security, architecture]
dependencies: []
---

# Raw Wallet object exposed on OnchainContext but unused

## Problem Statement

The `wallet: Wallet` field on the `ready` variant of `OnchainContextValue` exposes the raw BDK Wallet to all React components. No consumer uses it — `generateAddress`, `estimateFee`, `sendToAddress`, and `sendMax` encapsulate all wallet operations. Exposing it violates least-privilege and means any XSS vulnerability has direct signing access.

## Findings

**Location:** `src/onchain/onchain-context.ts`, line 21

No component in the tree imports or accesses `wallet` from context.

Flagged by: security-sentinel, code-simplicity-reviewer

## Proposed Solutions

### Option A: Remove wallet from context (Recommended)
Delete `wallet: Wallet` from the ready variant. If a future feature needs raw access, add it then.

- Effort: Small
- Risk: Low — no consumers

## Acceptance Criteria

- [ ] wallet field removed from OnchainContextValue ready variant
- [ ] All tests still pass
- [ ] No component imports Wallet type from context
