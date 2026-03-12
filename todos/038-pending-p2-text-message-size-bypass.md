---
status: pending
priority: p2
issue_id: "038"
tags: [code-review, security, proxy]
dependencies: []
---

# Message size check only applies to ArrayBuffer, not text frames

## Problem Statement

The `maxMessageSize` check on line 54 of `index.ts` only triggers for `ArrayBuffer`. A text-frame WebSocket message bypasses the size limit entirely. While Lightning traffic is binary, the proxy should enforce limits consistently or reject text frames.

## Findings

- **Source:** Security Sentinel (M1), Simplicity Reviewer
- **Location:** `proxy/src/index.ts` lines 54-58

## Proposed Solutions

### Option A: Reject text frames entirely (Recommended)
Lightning peers only send binary data. Close the connection on text frames.

- **Effort:** Small
- **Risk:** Low

### Option B: Add size check for strings
Add `typeof data === 'string' && data.length > maxMessageSize` check.

- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] Text-frame messages are either rejected or size-checked
