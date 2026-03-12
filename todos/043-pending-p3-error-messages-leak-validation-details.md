---
status: pending
priority: p3
issue_id: "043"
tags: [code-review, security, proxy]
dependencies: []
---

# Error messages leak validation details to attackers

## Problem Statement

Error responses include specific details like `"Port 80 not allowed"`, `"Connection to private IP ranges is not allowed"`, and `"Expected /v1/{host}/{port}"`. This provides reconnaissance information to attackers probing the proxy.

## Findings

- **Source:** Security Sentinel (L2)
- **Location:** `proxy/src/validation.ts` lines 31-33; `proxy/src/index.ts` line 28

## Proposed Solutions

### Option A: Generic errors externally, detailed logs internally
Return `"Bad Request"` for all 400 responses. Log the specific reason via `console.log` (goes to Cloudflare Workers logs).

- **Effort:** Small
- **Risk:** Low — harder to debug from client side

## Acceptance Criteria

- [ ] Production error responses do not reveal validation logic
- [ ] Specific reasons logged server-side
