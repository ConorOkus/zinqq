---
status: cancelled
priority: p3
issue_id: '243'
tags: [code-review, payjoin, documentation, ci]
dependencies: []
---

# Capture CI patterns from PR #141 as institutional knowledge

## Problem Statement

`learnings-researcher` found no prior documented learnings on GitHub Actions multi-job orchestration, `permissions: {}`, `persist-credentials: false`, artifact handoff, or supply-chain hardening in `docs/solutions/`. PR #141 introduces all of these patterns for the first time in this repo. Future contributors (or future Claude) will rediscover them from scratch unless we commit the why.

## Findings

- `docs/solutions/build-errors/ci-setup-code-quality-fixes.md` is the only prior CI-related solution; it covers `--frozen-lockfile` and `cache: pnpm` but not the newer hardening.

## Proposed Solution

Add `docs/solutions/infrastructure/gha-multi-job-payjoin-ci.md` covering:

1. Why we split `payjoin-build` from `check` (failure isolation + critical-path cost).
2. The artifact-handoff pattern with `upload-artifact` / `download-artifact`.
3. Why `permissions: {}` + `persist-credentials: false` are scoped to jobs that build untrusted upstream code.
4. Cache-key anatomy: submodule SHA + `hashFiles(generate_bindings.sh, package-lock.json)`.
5. Known gaps still open (#234 test-utils script path, #236 action SHA pinning).

- Effort: Small.
- Risk: None.

## Technical Details

- New file: `docs/solutions/infrastructure/gha-multi-job-payjoin-ci.md`

## Acceptance Criteria

- [ ] Solution doc exists and covers the five topics above
- [ ] Linked from `docs/payjoin-build.md`

## Work Log

## Resources

- PR #141

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
