---
status: complete
priority: p2
issue_id: "076"
tags: [code-review, security, input-validation]
dependencies: []
---

# Peer host validation uses blocklist — should use DNS-safe allowlist

## Problem Statement

`parsePeerAddress` rejects hosts containing `/?#` but allows `@`, `\`, spaces, percent-encoded sequences, and other characters that could confuse the WebSocket proxy. The host is interpolated into a WebSocket URL (`wss://proxy/v1/${proxyHost}/${port}`), so a strict allowlist is more appropriate than a blocklist.

## Findings

- **File:** `src/ldk/peers/peer-connection.ts`, lines 138-140
- **Identified by:** kieran-typescript-reviewer, security-sentinel (H-3)
- Current: `host.length === 0 || /[/?#]/.test(host)`
- Should be: `/^[a-zA-Z0-9._-]+$/.test(host)`

## Acceptance Criteria

- [ ] Replace blocklist regex with allowlist: `/^[a-zA-Z0-9._-]+$/`
- [ ] Error message updated to reflect allowed characters
