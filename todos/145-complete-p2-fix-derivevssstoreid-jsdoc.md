---
status: pending
priority: p2
issue_id: 145
tags: [code-review, quality]
dependencies: []
---

# Fix deriveVssStoreId JSDoc to match implementation

## Problem Statement

The JSDoc says "Computes SHA-256 of the node public key (derived from the seed)" but the implementation just hashes the raw `ldkSeed` bytes directly. The comment about deriving via HDKey is not reflected in the code.

Flagged by: TypeScript reviewer, Security sentinel, Architecture strategist (all three).

## Findings

- `src/wallet/keys.ts:40-46` — JSDoc/comment misleads about what is being hashed

## Proposed Solutions

Update the comment to match reality:
```typescript
/**
 * Derive a deterministic VSS store_id from an LDK seed.
 * Computes SHA-256 of the raw seed bytes and returns the hex string.
 * This is unique per wallet and reproducible from the mnemonic alone.
 */
```

- **Effort**: Small
- **Risk**: None

## Acceptance Criteria

- [ ] JSDoc accurately describes the implementation
