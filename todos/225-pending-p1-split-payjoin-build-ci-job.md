---
status: pending
priority: p1
issue_id: '225'
tags: [code-review, payjoin, ci, architecture]
dependencies: ['224']
---

# Split Payjoin WASM build into its own CI job

## Problem Statement

The Payjoin build — `rustup target add`, `cargo install wasm-bindgen-cli --locked`, `npm install`, `scripts/generate_bindings.sh` — currently runs inline in the same `check` job as typecheck/lint/test/build. On cache miss it consumes most of the 15-minute `timeout-minutes` budget, and any transient failure in the Rust toolchain stalls typecheck, lint, and tests that have no Payjoin dependency.

## Findings

- `.github/workflows/ci.yml:46-66` — rustup + cargo install + generate_bindings.sh inline.
- `.github/workflows/ci.yml:16` — 15-minute timeout now covers Rust toolchain boot **and** the JS pipeline.
- Once PDK grows (v2 relay code, additional bindings in later upstream versions), this budget will be the first thing to break.

Flagged by `architecture-strategist` (P1).

Related: finding #224 (submodule install hardening) — both want the Payjoin build isolated; this one focuses on the time-budget and failure-isolation angle.

## Proposed Solution

Dedicated `payjoin-build` job that produces `dist/` as a GitHub Actions artifact, consumed by `check` via `download-artifact`. Sketch:

```yaml
jobs:
  payjoin-build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions: {} # see todo #224
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
      - name: Resolve submodule SHA
        id: sha
        run: echo "sha=$(git -C vendor/rust-payjoin rev-parse HEAD)" >> $GITHUB_OUTPUT
      - uses: actions/cache@v4
        id: cache
        with:
          path: vendor/rust-payjoin/payjoin-ffi/javascript/dist
          key: payjoin-dist-${{ steps.sha.outputs.sha }}-${{ hashFiles('vendor/rust-payjoin/payjoin-ffi/javascript/scripts/generate_bindings.sh', 'vendor/rust-payjoin/payjoin-ffi/javascript/package-lock.json') }}
      - if: steps.cache.outputs.cache-hit != 'true'
        run: |
          rustup target add wasm32-unknown-unknown
          cargo install -f wasm-bindgen-cli --version 0.2.108 --locked
          cd vendor/rust-payjoin/payjoin-ffi/javascript
          npm ci --ignore-scripts
          bash ./scripts/generate_bindings.sh
      - uses: actions/upload-artifact@v4
        with:
          name: payjoin-dist
          path: vendor/rust-payjoin/payjoin-ffi/javascript/dist

  check:
    needs: payjoin-build
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive # still needed for pnpm `link:` resolution
      - uses: actions/download-artifact@v4
        with:
          name: payjoin-dist
          path: vendor/rust-payjoin/payjoin-ffi/javascript/dist
      -  # existing pnpm install / typecheck / lint / test / build / proxy steps
```

- Pros: typecheck/test not blocked by Rust toolchain; parallel execution; explicit artifact contract; tighter per-job timeouts.
- Cons: Two jobs instead of one; small overhead per run.
- Effort: Medium.
- Risk: Low.

## Technical Details

- Affected files: `.github/workflows/ci.yml`

## Acceptance Criteria

- [ ] `payjoin-build` job owns Rust toolchain setup + WASM generation
- [ ] `check` job consumes `payjoin-dist` artifact via `download-artifact`
- [ ] Per-job timeouts set: `payjoin-build` 30m, `check` 15m
- [ ] Cache key includes submodule SHA + `generate_bindings.sh` + submodule's `package-lock.json` (see finding #229)

## Work Log

## Resources

- PR #140
