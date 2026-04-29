---
status: cancelled
priority: p3
issue_id: '240'
tags: [code-review, payjoin, ci, simplicity]
dependencies: []
---

# Remove redundant `if: cache-hit` gates on idempotent setup steps

## Problem Statement

`ci.yml:36, 40, 47, 54, 64` each guard with `if: steps.dist-cache.outputs.cache-hit != 'true'`. Five repetitions of the same condition for steps that are _either idempotent or already self-guarding_:

- `Add wasm32 target` (`rustup target add` is a no-op on rerun)
- `Cache cargo bin` (`actions/cache@v4` is already a no-op fetch on miss/hit)
- `Install wasm-bindgen-cli` (has its own `if ! command -v wasm-bindgen` guard)

Only two of the five gates are load-bearing: the `Cache rust build` step (which we can skip on dist-cache-hit because we don't need to restore target/) and the `Build Payjoin bindings` step itself.

## Findings

- `.github/workflows/ci.yml:36, 40, 47, 54, 64` — five `if:` repetitions.
- Steps at lines 37, 42, 53 are either idempotent or self-guarded.

Flagged by `code-simplicity-reviewer` (P1) and `architecture-strategist` (P3).

## Proposed Solution

Remove the `if:` gate from three steps:

- `ci.yml:36` — `Add wasm32 target`
- `ci.yml:40-45` — `Cache cargo bin` (the cache itself is harmless on dist-cache-hit)
- `ci.yml:47-51` — `Install wasm-bindgen-cli` (has `command -v` guard)

Keep the gate on `ci.yml:53-62` (`Cache rust build`) and `ci.yml:64-68` (`Build Payjoin bindings`).

- Effort: Small.
- Risk: None.

## Technical Details

- Affected file: `.github/workflows/ci.yml`

## Acceptance Criteria

- [ ] Three `if:` gates removed
- [ ] CI still hits dist-cache correctly (no rebuild on hit)
- [ ] Cold build path unchanged

## Work Log

## Resources

- PR #141

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
