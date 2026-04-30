---
status: pending
priority: p3
issue_id: '287'
tags: [code-review, security, api]
dependencies: []
---

# `api/vss-proxy.ts` should assert upstream origin to prevent token leak on misconfig

## Problem Statement

`api/vss-proxy.ts` forwards the client's `Authorization` header verbatim to whatever `VSS_ORIGIN` resolves to at runtime. If `VSS_ORIGIN` is ever misconfigured (typo, copy-paste from a wrong env, accidental commit of a dev value into prod), the user's bearer token leaks to the misconfigured host.

Pre-existing — not introduced by PR #147. Filing because the new lint coverage on `api/**` makes this newly visible, and the cost of the fix is small.

## Findings

- `api/vss-proxy.ts:31-32` — `Authorization` header pass-through.
- Flagged by `security-sentinel` during PR #147 follow-up review.

## Proposed Solution

Parse the `VSS_ORIGIN` env var at module init, assert it's `https://` and matches an expected hostname pattern (e.g. ends with `.zinqq.app` or is a known VSS provider domain), and refuse to start the function with a clear error if it doesn't.

**Effort:** 20 min.
**Risk:** Low.

## Acceptance Criteria

- [ ] `VSS_ORIGIN` is validated at init time.
- [ ] A misconfigured value produces a clean 500 with a non-leaking message.

## Resources

- **PR:** #147
- **Reviewer:** `security-sentinel`

## Work Log

### 2026-04-29 — Surfaced during PR #147 follow-up review
**By:** security-sentinel
