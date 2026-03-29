---
status: pending
priority: p2
issue_id: '184'
tags: [code-review, security, lsps2]
---

# Validate LSP config at init time

## Problem Statement

LSP config values (nodeId, host, port) are not validated at `initializeLdk()` time. An invalid `lspNodeId` (wrong length, uppercase hex) silently passes through and only fails at runtime when the user tries to receive. Port could be `NaN` from invalid env var.

## Findings

- Security sentinel: HIGH - pubkey format not checked, could cause silent failures or in theory match wrong peer
- Architecture: config should be validated early, consistent with existing peer address validation

## Proposed Solutions

1. Add regex validation in `initializeLdk()`: pubkey matches `/^[0-9a-f]{66}$/`, port is 1-65535
2. Validate port with `Number.isFinite()` check

## Technical Details

- **Affected files:** `src/ldk/init.ts`, `src/ldk/config.ts`
- **Effort:** Small

## Acceptance Criteria

- [ ] Invalid `lspNodeId` throws clear error at init
- [ ] Non-numeric port throws at init
- [ ] Empty `lspNodeId` is allowed (disables LSPS2)

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/60
