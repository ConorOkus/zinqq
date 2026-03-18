---
status: pending
priority: p3
issue_id: "015"
tags: [code-review, security]
dependencies: []
---

# WASM binary loaded without integrity verification

## Problem Statement

`initializeWasmWebFetch('/liblightningjs.wasm')` in `src/ldk/init.ts` fetches the WASM binary from the same origin with no hash verification. A compromised static file server could substitute a malicious WASM binary that exfiltrates keys. Required before mainnet deployment.

## Acceptance Criteria

- [ ] SHA-256 hash of WASM binary verified after fetch, before instantiation
- [ ] Pinned hash constant updated when LDK version changes
