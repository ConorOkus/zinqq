---
status: pending
priority: p2
issue_id: '187'
tags: [code-review, security, lsps2]
---

# Verify node secret key derivation at runtime

## Problem Statement

`deriveNodeSecret()` assumes LDK derives the node secret from BIP32 `m/0'`. If LDK changes this derivation path, invoices would be signed with the wrong key, causing silent payment failures. The comment says "can be verified at runtime" but this check is never performed.

## Findings

- Security sentinel: CRITICAL-1 (partial) - no runtime verification
- TS reviewer: HIGH - should verify derived pubkey matches node ID
- Architecture: recommended as a one-liner that prevents catastrophic failure

## Proposed Solutions

1. At init time, derive public key from `nodeSecretKey` and compare against `keysManager.as_NodeSigner().get_node_id()`. Fail hard on mismatch.
2. Also call `master.wipePrivateData()` on the HDKey after derivation to zero intermediate key material.

## Technical Details

- **Affected files:** `src/ldk/init.ts`, `src/ldk/lsps2/node-secret.ts`
- **Effort:** Small

## Acceptance Criteria

- [ ] Runtime check compares derived pubkey vs node ID
- [ ] Hard failure if mismatch
- [ ] HDKey intermediate material wiped after derivation

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/60
