---
status: complete
priority: p1
issue_id: "034"
tags: [code-review, security, input-validation]
dependencies: []
---

# Peer address host and pubkey not validated — path traversal + hex injection

## Problem Statement

`parsePeerAddress` validates pubkey length (66 chars) and port range but does NOT validate:
1. **Host**: slashes, query strings, fragments pass through to the WebSocket URL, enabling path traversal on the proxy (`wss://proxy/v1/../../admin/9735`)
2. **Pubkey hex**: any 66-character string passes, including non-hex chars that produce silent NaN→0 corruption in `hexToBytes`

## Findings

- **Source:** Security Sentinel (Finding 1, 2), TypeScript Reviewer (P1-2)
- **Location:** `src/ldk/peers/peer-connection.ts` lines 117-137

## Proposed Solutions

### Option A: Add regex validation for both (Recommended)
```typescript
if (!/^[0-9a-fA-F]{66}$/.test(pubkey)) {
  throw new Error('Invalid peer address: pubkey must be 66 hex characters')
}
if (/[/?#\\\s]/.test(host) || host.length === 0) {
  throw new Error('Invalid peer address: host contains invalid characters')
}
```
- **Effort:** Small

## Acceptance Criteria

- [ ] Pubkey validated as hex via regex
- [ ] Host rejects `/`, `?`, `#`, `\`, whitespace
- [ ] Tests added for each validation case

## Work Log

| Date | Action | Details |
|------|--------|---------|
| 2026-03-12 | Created | From PR #4 code review |
