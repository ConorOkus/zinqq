---
status: pending
priority: p2
issue_id: '229'
tags: [code-review, payjoin, ci]
dependencies: []
---

# Expand Payjoin CI cache key to cover build-script + lockfile changes

## Problem Statement

The cache key at `.github/workflows/ci.yml:59` is `payjoin-build-${{ steps.payjoin-sha.outputs.sha }}` — keyed only on the submodule HEAD SHA. If a future PR bumps `scripts/generate_bindings.sh` or `payjoin-ffi/javascript/package-lock.json` **without** bumping the submodule (e.g. a cherry-picked upstream change, or a local patch in-submodule — hypothetical but possible), the stale cache is reused and CI ships against the old build.

Related: security-sentinel flagged the same concern as a supply-chain signal — a stale cache silently serving pre-change artefacts defeats review.

## Findings

- `.github/workflows/ci.yml:58-59` — single-component cache key.

Flagged by `security-sentinel` (P3) and `architecture-strategist`.

## Proposed Solution

Hash the build-script and the bindings' lockfile into the cache key:

```yaml
key: payjoin-build-${{ steps.payjoin-sha.outputs.sha }}-${{ hashFiles('vendor/rust-payjoin/payjoin-ffi/javascript/scripts/generate_bindings.sh', 'vendor/rust-payjoin/payjoin-ffi/javascript/package-lock.json', 'vendor/rust-payjoin/Cargo.lock') }}
```

`Cargo.lock` inclusion also catches a wasm-bindgen version bump from upstream.

- Effort: Small.
- Risk: None (false-cache-miss, never false-cache-hit).

## Technical Details

- Affected file: `.github/workflows/ci.yml`

## Acceptance Criteria

- [ ] Cache key includes submodule SHA + generate_bindings.sh + package-lock.json + Cargo.lock
- [ ] CI runs still hit the cache on unchanged PRs

## Work Log

## Resources

- PR #140
