---
status: complete
priority: p3
issue_id: '286'
tags: [code-review, ci, infra]
dependencies: []
---

# CI single source of truth for pnpm version

## Problem Statement

Todo 274 pinned pnpm via `"packageManager": "pnpm@10.32.1"` in `package.json`. The CI workflow at `.github/workflows/ci.yml:24-26` still hardcodes `pnpm/action-setup@v4 with: version: 10` (major-only). Drift between `packageManager` and the action input is now bounded but not eliminated — if someone bumps `packageManager` to `pnpm@11.x` and forgets the workflow, they'll diverge again.

`pnpm/action-setup@v4` supports reading version from `packageManager` if you omit `version:` and rely on Corepack.

## Findings

- `.github/workflows/ci.yml:24-26` — `with: version: 10`.
- `package.json` — `"packageManager": "pnpm@10.32.1"`.
- Flagged by `security-sentinel` during PR #147 follow-up review.

## Proposed Solution

Drop `with: version: 10` from the action call (or leave `with:` empty); `pnpm/action-setup@v4` will read `packageManager` automatically when corepack is enabled. Verify CI still passes.

**Effort:** 10 min.
**Risk:** Low.

## Acceptance Criteria

- [ ] Pnpm version exists in exactly one source of truth (`package.json`).
- [ ] CI build still passes.

## Resources

- **PR:** #147
- **Reviewer:** `security-sentinel`
- **Related:** todo 274

## Work Log

### 2026-04-29 — Surfaced during PR #147 follow-up review
**By:** security-sentinel
