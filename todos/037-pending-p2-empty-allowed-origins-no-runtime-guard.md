---
status: pending
priority: p2
issue_id: "037"
tags: [code-review, security, proxy]
dependencies: []
---

# Production ALLOWED_ORIGINS is empty with no runtime guard

## Problem Statement

`wrangler.toml` production env sets `ALLOWED_ORIGINS = ""`. After `split(',').filter(Boolean)`, this produces an empty array — every request gets 403. No startup validation warns the deployer. Running `wrangler dev` without `--env` also has no `ALLOWED_ORIGINS` defined, causing a runtime crash on `.split()`.

## Findings

- **Source:** Security Sentinel (C2), Architecture Strategist, Agent-Native Reviewer, TypeScript Reviewer
- **Location:** `proxy/wrangler.toml` lines 5-7, 18-20; `proxy/src/index.ts` lines 17-19

## Proposed Solutions

### Option A: Add runtime guard and top-level default (Recommended)
Return 500 with a clear message if `ALLOWED_ORIGINS` is empty/undefined. Add a placeholder to top-level `[vars]`.

- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] Worker returns 500 (not 403) when ALLOWED_ORIGINS is misconfigured
- [ ] Top-level `[vars]` includes `ALLOWED_ORIGINS` with empty default
- [ ] Comment in wrangler.toml explaining production value must be set
