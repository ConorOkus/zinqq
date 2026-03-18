---
status: pending
priority: p3
issue_id: '103'
tags: [code-review, security, quality]
dependencies: []
---

# Mutable Uint8Array stored in React state without defensive copy

## Problem Statement

In `CloseChannel.tsx`, `counterpartyNodeId` is assigned directly from `counterparty.get_node_id()` and stored in component state. If LDK reuses that buffer internally, external mutation could silently corrupt React state. A defensive copy prevents this.

## Findings

- **File**: `src/pages/CloseChannel.tsx:63` — `counterpartyNodeId: counterparty.get_node_id()`
- **Identified by**: kieran-typescript-reviewer
- **Known Pattern**: See `docs/solutions/integration-issues/ldk-wasm-write-vs-direct-uint8array.md`

## Proposed Solution

Defensively copy: `counterpartyNodeId: new Uint8Array(counterparty.get_node_id())`

- **Effort**: Trivial (1 line change)
- **Risk**: None

## Acceptance Criteria

- [ ] `counterpartyNodeId` is a defensive copy, not a shared reference
