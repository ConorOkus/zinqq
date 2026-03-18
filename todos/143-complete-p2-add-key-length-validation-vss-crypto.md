---
status: pending
priority: p2
issue_id: 143
tags: [code-review, security, crypto]
dependencies: []
---

# Add key length validation to vssEncrypt/vssDecrypt

## Problem Statement

Neither `vssEncrypt` nor `vssDecrypt` validates that the key is exactly 32 bytes. ChaCha20-Poly1305 requires a 256-bit key. A truncated or oversized key would produce a generic library error instead of a clear message.

## Findings

- `src/ldk/storage/vss-crypto.ts:9` — `vssEncrypt` accepts any `Uint8Array` as key
- `src/ldk/storage/vss-crypto.ts:25` — `vssDecrypt` same issue

## Proposed Solutions

Add guard at top of both functions:
```typescript
if (key.length !== 32) {
  throw new Error(`[VSS Crypto] Key must be exactly 32 bytes, got ${key.length}`)
}
```

- **Effort**: Small
- **Risk**: None

## Acceptance Criteria

- [ ] Both functions throw descriptive error for non-32-byte keys
- [ ] Test added for invalid key length
