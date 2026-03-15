---
status: pending
priority: p3
issue_id: "072"
tags: [code-review, architecture]
dependencies: []
---

# Extract send operations into standalone service for agent parity

## Problem Statement

The 5 core onchain operations (estimateFee, estimateMaxSendable, sendToAddress, sendMax, generateAddress) are defined as useCallback closures inside OnchainProvider. They close over walletRef/esploraRef, meaning an agent cannot call them without mounting a React tree.

## Findings

**Location:** `src/onchain/context.tsx`, lines 104-245

The operations are well-designed primitives but locked behind React context. BIP21 parser is already standalone and agent-accessible.

Flagged by: agent-native-reviewer

## Proposed Solutions

### Option A: Extract createOnchainService factory
Create `createOnchainService(wallet, esploraClient)` returning the 5 operations. Provider instantiates and exposes through context. Agents instantiate directly after initializeBdkWallet().

- Effort: Medium
- Risk: Low

## Acceptance Criteria

- [ ] Send operations callable without React context
- [ ] Provider delegates to service instance
- [ ] initializeBdkWallet + createOnchainService is the agent entry point
