---
status: pending
priority: p1
issue_id: "035"
tags: [code-review, security, proxy]
dependencies: []
---

# DNS rebinding bypasses SSRF protection for hostname targets

## Problem Statement

`isPrivateIP` only validates dotted-decimal IPv4 literals. Any hostname (e.g., `localhost`, `attacker-domain.com` resolving to `127.0.0.1`) passes validation. Cloudflare's `connect()` resolves DNS server-side, so an attacker with an allowed origin can reach internal IPs via a controlled hostname.

## Findings

- **Source:** Security Sentinel (C1), TypeScript Reviewer, Architecture Strategist, Agent-Native Reviewer
- **Location:** `proxy/src/validation.ts` lines 46-65
- **Evidence:** The test on line 163 acknowledges this: `"allows hostname (cannot validate DNS)"`. The string `localhost` passes `isPrivateIP` because it doesn't match the IPv4 regex.

## Proposed Solutions

### Option A: Block well-known private hostnames explicitly (Recommended for now)
Add a blocklist for `localhost`, `*.local`, `*.internal`, and IPv6 literals (`::1`, `::ffff:*`). This is not a complete fix but closes the most obvious vectors.

- **Pros:** Simple, no external dependencies, catches common cases
- **Cons:** Does not prevent custom domains resolving to private IPs
- **Effort:** Small
- **Risk:** Low

### Option B: Resolve DNS before validation
Perform a DNS lookup (via `fetch` to a DoH endpoint) before calling `connect()`, validate the resolved IP. This has a TOCTOU race but significantly raises the bar.

- **Pros:** Catches DNS rebinding
- **Cons:** Adds latency, TOCTOU race, more complex
- **Effort:** Medium
- **Risk:** Medium

### Option C: Document as accepted risk
The proxy is port-restricted to 9735 and Cloudflare Workers run in isolated network contexts. Document this limitation with a code comment and tracking issue.

- **Pros:** Zero code change
- **Cons:** Residual SSRF risk, though limited blast radius
- **Effort:** None
- **Risk:** Accepted

## Acceptance Criteria

- [ ] `localhost` is blocked by the proxy
- [ ] IPv6 loopback literals (`::1`, `::ffff:127.0.0.1`) are blocked
- [ ] Known limitation documented in code comment
