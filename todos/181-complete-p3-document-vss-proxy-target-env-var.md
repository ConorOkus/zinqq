---
status: complete
priority: p3
issue_id: '181'
tags: [code-review, documentation]
dependencies: []
---

# Document VSS_PROXY_TARGET in .env.example

## Problem Statement

`.env.example` documents `VITE_VSS_URL` and mentions "the Vite proxy forwards /\_\_vss_proxy to VSS_PROXY_TARGET", but `VSS_PROXY_TARGET` itself is not listed in the file. A new developer cloning the repo will have the Vite proxy silently fall back to `http://localhost:8080`, which fails with no obvious explanation.

**Files:** `.env.example`, `vite.config.ts:68`

## Findings

- Flagged by TypeScript reviewer (PR #46 review)
- `VSS_PROXY_TARGET` is a Node-side env var (no `VITE_` prefix), only used by the Vite dev server proxy
- Default value is `http://localhost:8080` per `vite.config.ts:68`
- Current `.env` has it set to `http://98.207.69.189:52146`

## Proposed Solutions

### Option A: Add to .env.example with comment

Add `VSS_PROXY_TARGET=http://localhost:8080` to `.env.example` with a comment explaining it's the local dev proxy target.

- **Pros:** Complete documentation in one file
- **Cons:** None
- **Effort:** Small
- **Risk:** None
