---
status: complete
priority: p2
issue_id: "020"
tags: [code-review, security, input-validation]
dependencies: []
---

# No runtime validation on Esplora API responses or hex input

## Problem Statement

`EsploraClient` uses bare `as T` type assertions on all JSON responses with no runtime validation. A compromised or misbehaving Esplora server could return malformed data that silently corrupts LDK state. Additionally, `hexToBytes` in `utils.ts` accepts invalid hex strings, returning corrupted byte arrays (NaN → 0 in Uint8Array).

## Findings

- **Source:** Security Sentinel (H1, H2), TypeScript Reviewer
- **Location:** `src/ldk/sync/esplora-client.ts` (all JSON endpoints), `src/ldk/utils.ts:7-12`
- **Evidence:** `return (await res.json()) as BlockStatus` — no validation; `parseInt("zz", 16)` returns NaN → 0

## Proposed Solutions

### Option A: Add zod schemas for Esplora responses + hex validation
- Define zod schemas for BlockStatus, TxStatus, MerkleProof, OutspendStatus
- Validate `hexToBytes` input with regex `/^[0-9a-fA-F]*$/` and even-length check
- **Effort:** Small-Medium

## Acceptance Criteria

- [ ] All Esplora JSON responses validated at runtime
- [ ] `hexToBytes` throws on invalid hex input
- [ ] `hexToBytes` throws on odd-length input

## Work Log

| Date | Action | Details |
|------|--------|---------|
| 2026-03-11 | Created | From PR #3 code review |
