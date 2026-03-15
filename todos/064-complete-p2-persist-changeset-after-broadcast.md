---
status: pending
priority: p2
issue_id: "064"
tags: [code-review, security]
dependencies: []
---

# Changeset persisted before broadcast success

## Problem Statement

The wallet changeset (recording spent UTXOs) is persisted to IndexedDB before the transaction is broadcast. If broadcast fails, the wallet state on disk reflects spent UTXOs for a transaction that was never broadcast, causing a stale balance until the next sync corrects it.

## Findings

**Location:** `src/onchain/context.tsx`, lines 188-193

```typescript
wallet.sign(psbt, new SignOptions())
persistChangeset(wallet)          // persisted here
const tx = psbt.extract_tx()
await esplora.broadcast(tx)       // broadcast here (may fail)
```

Flagged by: security-sentinel

## Proposed Solutions

### Option A: Persist after broadcast (Recommended)
Move `persistChangeset(wallet)` to after `await esplora.broadcast(tx)`. If broadcast succeeds but persistence fails, the next sync reconciles.

- Pros: Strictly safer — no stale state on broadcast failure
- Cons: If browser crashes between broadcast and persistence, the next sync reconciles
- Effort: Small
- Risk: Low

## Acceptance Criteria

- [ ] persistChangeset is called after successful broadcast
- [ ] If broadcast fails, staged changes are discarded
- [ ] Error screen message "Your funds are safe" remains accurate
