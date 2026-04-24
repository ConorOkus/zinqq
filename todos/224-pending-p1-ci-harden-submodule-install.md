---
status: pending
priority: p1
issue_id: '224'
tags: [code-review, payjoin, security, ci, supply-chain]
dependencies: []
---

# Harden CI install of the Payjoin submodule

## Problem Statement

The `.github/workflows/ci.yml` Payjoin build step runs arbitrary upstream lifecycle scripts with the default job permissions (including `GITHUB_TOKEN` scope and access to any repo secrets).

The submodule's own `payjoin-ffi/javascript/package.json` has `uniffi-bindgen-react-native@0.30.0-1` as a devDependency, which declares its own `prepare` scripts. A hostile upstream commit could run arbitrary code on the GitHub runner, poison the build cache, or push back to the Zinqq repo.

## Findings

- `.github/workflows/ci.yml:20` — `submodules: recursive` fetches full upstream history and subsubmodules.
- `.github/workflows/ci.yml:64-66` — runs `npm install` (not `npm ci`) inside the submodule, executing any `preinstall` / `prepare` / `postinstall` scripts in the dep tree.
- Cache key at `.github/workflows/ci.yml:59` is `payjoin-build-${sha}` — cache poisoning is a known GHA threat; a poisoned cache silently serves pre-compromised WASM.

Flagged by `security-sentinel` (P1).

## Proposed Solutions

### Option 1 — Isolate the Payjoin build in a no-secret job

Split `.github/workflows/ci.yml:14-93` into two jobs:

```yaml
jobs:
  payjoin-build:
    runs-on: ubuntu-latest
    permissions: {} # no GITHUB_TOKEN
    env:
      NPM_CONFIG_IGNORE_SCRIPTS: 'true'
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
          persist-credentials: false
      -  # rustup, wasm-bindgen-cli install, npm ci, generate_bindings.sh
      - uses: actions/upload-artifact@v4
        with:
          name: payjoin-dist
          path: vendor/rust-payjoin/payjoin-ffi/javascript/dist

  check:
    needs: payjoin-build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive # still need the linked source for `link:` resolution
          persist-credentials: false
      - uses: actions/download-artifact@v4
        with:
          name: payjoin-dist
          path: vendor/rust-payjoin/payjoin-ffi/javascript/dist
      -  # pnpm install, typecheck, test, build
```

- Pros: Compromised upstream code never holds `GITHUB_TOKEN`; typecheck/test decoupled from WASM build cost; artifact is the explicit contract.
- Cons: Two jobs; marginally higher wall-clock on cache miss.
- Effort: Medium.
- Risk: Low.

### Option 2 — Stay in one job, add `--ignore-scripts` + scoped permissions

Keep the single-job layout but add `permissions: {}` at the job level and `--ignore-scripts` on the submodule's `npm ci`.

- Pros: Smaller diff.
- Cons: Risk of breaking the build if `uniffi-bindgen-react-native` relies on its `prepare` script; doesn't decouple typecheck from WASM failures.
- Effort: Small.
- Risk: Medium (may need per-dep allowances).

## Recommended Action

Option 1. It also composes with finding #225 (split payjoin-build into separate CI job — architectural benefit) and #230 (`npm ci --ignore-scripts`).

## Technical Details

- Affected files: `.github/workflows/ci.yml`

## Acceptance Criteria

- [ ] Payjoin build runs in a job with `permissions: {}`
- [ ] Submodule checkout uses `persist-credentials: false`
- [ ] `npm install` replaced with `npm ci --ignore-scripts` (requires validating the build still succeeds)
- [ ] Built artefact flows via `upload-artifact` / `download-artifact`, not shared working tree
- [ ] CI green on a PR using the new layout

## Work Log

## Resources

- PR #140
- GHA cache-poisoning attack surface: https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions
