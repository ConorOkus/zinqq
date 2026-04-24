---
status: complete
priority: p3
issue_id: '239'
tags: [code-review, payjoin, ci, vercel, simplicity]
dependencies: ['234']
---

# Consolidate Payjoin build recipe between CI and Vercel

## Problem Statement

The Payjoin build recipe now lives in two places:

- `.github/workflows/ci.yml:35-68` — GHA payjoin-build job
- `scripts/vercel-install.sh:27-44` — Vercel install hook

They duplicate: wasm-bindgen-cli version (`0.2.108` hardcoded in both), the `rustup target add wasm32-unknown-unknown` step, the `npm ci --ignore-scripts` inside the submodule, and the call to `generate_bindings.sh`. When we bump `WASM_BINDGEN_VERSION`, we must edit both.

Todo #234's proposed fix is to stop calling `generate_bindings.sh` directly (skip `build:test-utils`). That change converges cleanly with consolidating the recipe into a shared script.

## Findings

- `.github/workflows/ci.yml:44, 50` — wasm-bindgen version hardcoded twice.
- `scripts/vercel-install.sh:13` — same version hardcoded again.

Flagged by `architecture-strategist` (P3).

## Proposed Solution

Create `scripts/build-payjoin-bindings.sh` containing the exact sequence of:

1. `rustup target add wasm32-unknown-unknown`
2. `cargo install --locked wasm-bindgen-cli --version "$WASM_BINDGEN_VERSION"` (with existing-version guard)
3. `cd vendor/rust-payjoin/payjoin-ffi/javascript && npm ci --ignore-scripts`
4. The MSRV-hack `cargo add` step from `generate_bindings.sh:18-20` (vendored into our script)
5. `npm run build` (skips `build:test-utils` — see todo #234)

Both `ci.yml` and `vercel-install.sh` invoke `bash scripts/build-payjoin-bindings.sh` and layer their own caching on top.

Source-pin `WASM_BINDGEN_VERSION` at the top of the shared script and reference from both callers.

- Effort: Small.
- Risk: Low — strictly refactor of an already-working flow.

## Technical Details

- New file: `scripts/build-payjoin-bindings.sh`
- Modified: `.github/workflows/ci.yml`, `scripts/vercel-install.sh`, `docs/payjoin-build.md`, `package.json` (`payjoin:build` script points at new file)

## Acceptance Criteria

- [ ] Single source of truth for the build recipe
- [ ] `WASM_BINDGEN_VERSION` declared once
- [ ] Both CI and Vercel succeed

## Work Log

## Resources

- PR #141
