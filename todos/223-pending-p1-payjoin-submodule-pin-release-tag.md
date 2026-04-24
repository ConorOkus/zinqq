---
status: pending
priority: p1
issue_id: '223'
tags: [code-review, payjoin, security, supply-chain]
dependencies: []
---

# Pin `vendor/rust-payjoin` submodule to a release tag, not master HEAD

## Problem Statement

The submodule is pinned to `e22e37249f39c0f4a4b1f8888e51704c9c418a9c` — upstream master's HEAD as of 2026-04-23 — not a release tag. A force-push rewrite, a compromised commit, or a transitive maintainer takeover between the tag cut and the release would flow straight into Zinqq CI and the production WASM bundle served to wallet users.

This is a self-custodial Bitcoin wallet: the WASM payload runs in-browser with access to PSBTs and seed material. Supply-chain hygiene is load-bearing.

## Findings

- `.gitmodules:3` — submodule tracks master.
- Upstream has published release tags recently: `payjoin-0.25.0` (Mar 2026), `payjoin-1.0.0-rc.2` (Feb 2026), `payjoin-ffi-0.24` (Jul 2025). Any of these is a more defensible pin than a random master SHA.
- `docs/payjoin-build.md` currently describes pointing the submodule at "a specific commit-or-tag" but the PR itself picks master HEAD.

Flagged by `security-sentinel` (P1).

## Proposed Solutions

### Option 1 — Pin to `payjoin-1.0.0-rc.2`

The most recent RC upstream marked as shippable. `payjoin-0.25.0` is technically newer but is a crate-specific tag not known to align with the `payjoin-ffi/javascript` bindings surface.

```sh
cd vendor/rust-payjoin
git checkout payjoin-1.0.0-rc.2
cd ../..
git add vendor/rust-payjoin
```

Then re-verify the build and the `wasm-bindgen` crate version in the tagged `Cargo.lock` — the wasm-bindgen-cli pin in CI (`.github/workflows/ci.yml:43`) may need updating to match.

- Pros: A tag upstream considers shippable; signature verifiable; rollback target.
- Cons: May require wasm-bindgen-cli version re-pin.
- Effort: Small.
- Risk: Low (worst case: rebuild with a slightly different wasm-bindgen-cli).

### Option 2 — Pin to latest ffi-specific tag `payjoin-ffi-0.24`

Older (Jul 2025) but explicitly tags the bindings surface.

- Pros: Tag matches the directory we consume.
- Cons: Loses recent upstream work.
- Effort: Small.
- Risk: Low.

### Option 3 — Keep master HEAD, add commit-signature verification

Require HEAD commit be signed by a maintainer-controlled GPG key (`git -C vendor/rust-payjoin verify-commit HEAD`) gated in CI.

- Pros: Moves with upstream.
- Cons: Doesn't mitigate force-push rewrite; requires maintaining a trusted-keys list; upstream commit signing is not universal.
- Effort: Medium.
- Risk: Medium.

## Recommended Action

Option 1 as default. If the build breaks on `payjoin-1.0.0-rc.2`, fall back to Option 2.

## Technical Details

- Affected files: `.gitmodules`, submodule pointer in the tree, possibly `.github/workflows/ci.yml:43` (wasm-bindgen-cli version), `docs/payjoin-build.md:11` (documented version).

## Acceptance Criteria

- [ ] Submodule HEAD is a named upstream tag, not a loose commit
- [ ] `pnpm payjoin:build` succeeds against the chosen tag
- [ ] Documented tag name in `docs/payjoin-build.md`
- [ ] CI `wasm-bindgen-cli --version` flag matches the tag's `Cargo.lock`

## Work Log

## Resources

- PR #140
- Upstream releases: https://github.com/payjoin/rust-payjoin/releases
