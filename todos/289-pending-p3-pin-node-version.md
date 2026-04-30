---
status: pending
priority: p3
issue_id: '289'
tags: [code-review, infra, deploy]
dependencies: []
---

# Pin Node version across CI / Vercel / local

## Problem Statement

Todo 274 pinned pnpm via `"packageManager"`. Node version is still implicit: CI uses `actions/setup-node@v4 with: node-version: 22`, Vercel selects from project dashboard (invisible to source control), local dev uses whatever the contributor has installed.

A `engines.node` field in `package.json` or a top-level `.nvmrc` would make Node version the same single-source-of-truth pattern as pnpm.

## Findings

- `.github/workflows/ci.yml` — pins Node 22 via setup action.
- `package.json` — no `engines.node`.
- No `.nvmrc` / `.node-version` at repo root.
- Flagged by `architecture-strategist` during PR #147 follow-up review.

## Proposed Solution

Add `"engines": { "node": ">=22 <23" }` to `package.json` (or pin tighter) and a matching `.nvmrc` at the repo root. Update CI and Vercel to read from those instead of hardcoding.

**Effort:** 15 min.
**Risk:** Low.

## Acceptance Criteria

- [ ] Node version in one source of truth.
- [ ] CI + Vercel both still pass.

## Resources

- **PR:** #147
- **Reviewer:** `architecture-strategist`

## Work Log

### 2026-04-29 — Surfaced during PR #147 follow-up review
**By:** architecture-strategist
