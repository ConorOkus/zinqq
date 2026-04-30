---
status: pending
priority: p3
issue_id: '285'
tags: [code-review, supply-chain, security, infra]
dependencies: []
---

# Add `+sha512.…` hash-pin to `packageManager` for corepack integrity

## Problem Statement

Todo 274 added `"packageManager": "pnpm@10.32.1"` to `package.json`. Corepack supports an optional integrity hash suffix (`pnpm@10.32.1+sha512.…`) that verifies the downloaded pnpm tarball against a known-good hash. Without it, integrity relies on the npm registry's own checks at fetch time.

For a non-custodial wallet build the marginal hardening is worth taking. Existing `pnpm install --frozen-lockfile` still provides integrity guarantees on installed deps; this is one layer up.

## Findings

- `package.json` — `"packageManager": "pnpm@10.32.1"` (no hash suffix).
- Flagged by `security-sentinel` during PR #147 follow-up review.

## Proposed Solution

Generate the hash with `corepack use pnpm@10.32.1` (writes the hashed form back to package.json) or compute manually from the pnpm npm tarball, then commit.

**Effort:** 10 min.
**Risk:** None.

## Acceptance Criteria

- [ ] `packageManager` field carries `+sha512.…` suffix.
- [ ] CI + Vercel installs both still pass.

## Resources

- **PR:** #147
- **Reviewer:** `security-sentinel`

## Work Log

### 2026-04-29 — Surfaced during PR #147 follow-up review
**By:** security-sentinel
