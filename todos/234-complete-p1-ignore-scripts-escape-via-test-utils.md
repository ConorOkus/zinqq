---
status: complete
priority: p1
issue_id: '234'
tags: [code-review, payjoin, security, supply-chain, ci, vercel]
dependencies: []
---

# `--ignore-scripts` is bypassed by `generate_bindings.sh` via test-utils

## Problem Statement

PR #141 adds `npm ci --ignore-scripts` at the outer install step, but `scripts/generate_bindings.sh` then runs `npm run build:test-utils` which does `cd test-utils && npm install` **with no flags** — arbitrary upstream lifecycle scripts execute at build time. On Vercel, that code runs with production secrets in scope (`VERCEL_TOKEN`, proxy creds, any `VSS_*` env). On GitHub Actions the blast radius is capped by `permissions: {}`, but the hardening is still a half-measure.

Additionally, `generate_bindings.sh:18-25` does a `cd node_modules/uniffi-bindgen-react-native && cargo add home@=0.5.11` MSRV patch — another upstream-code-execution point.

Worse: `test-utils` is only needed for **upstream's own tests**, not for Zinqq's consumption of the bindings. We never use `test-utils` artifacts. Building them is pure overhead and a supply-chain liability.

## Findings

- `vendor/rust-payjoin/payjoin-ffi/javascript/scripts/generate_bindings.sh:24-25` — runs both `npm run build` and `npm run build:test-utils`.
- `vendor/rust-payjoin/payjoin-ffi/javascript/package.json` — `"build:test-utils": "cd test-utils && npm install && npx @napi-rs/cli build"`. The nested `npm install` has no `--ignore-scripts`.
- `scripts/vercel-install.sh:37` — `npm ci --ignore-scripts` at install time; lifecycle scripts bypassed downstream.
- `.github/workflows/ci.yml:67` — same pattern in CI.

Flagged by `security-sentinel` (P1). Independent verification confirmed the claim.

## Proposed Solutions

### Option 1 — Skip `build:test-utils` entirely (recommended)

We don't consume `test-utils`; it's upstream's native test helper (napi-rs bindings to Rust test fixtures). Skipping it avoids the nested `npm install` and an extra ~1-2 min compile.

Can't simply modify `generate_bindings.sh` (it's in the submodule). Options:
- (a) Run the steps directly in CI/Vercel, replicating `generate_bindings.sh:1-24` verbatim but stopping before line 25. Accept upstream-script-drift risk.
- (b) Fork the script into `scripts/payjoin-build.sh`, source-patched from upstream on each submodule bump.
- (c) Run `generate_bindings.sh` with `SKIP_TEST_UTILS=1` env + upstream-PR the guard. Long-turnaround.

Prefer (a): it keeps our build recipe under our review. Composes with architecture-strategist's P3 ("extract shared `scripts/build-payjoin-bindings.sh`") — same fix, two motivations.

### Option 2 — `NPM_CONFIG_IGNORE_SCRIPTS=true` env var

Set globally so transitive `npm install`s inherit it:

```yaml
# ci.yml payjoin-build job
env:
  NPM_CONFIG_IGNORE_SCRIPTS: "true"
```

```sh
# scripts/vercel-install.sh
export NPM_CONFIG_IGNORE_SCRIPTS=true
```

- Pros: Minimal diff; future-proof against new upstream nested scripts.
- Cons: May silently break `@napi-rs/cli build` which needs postinstall to download prebuilt native binaries — `test-utils` would fail. That's actually fine if we don't need test-utils, but the build script would error out. Combine with option 1 for a clean solution.

### Option 3 — Do both

Skip `build:test-utils` via option 1, **and** set `NPM_CONFIG_IGNORE_SCRIPTS=true` as defense-in-depth for the remaining `npm run build` chain.

## Recommended Action

Option 3. Option 1 eliminates the current exploit path; Option 2 protects against the next one.

## Technical Details

- Affected files: `.github/workflows/ci.yml`, `scripts/vercel-install.sh`, probably a new `scripts/payjoin-build.sh` (replacing the `generate_bindings.sh` call from both call sites)

## Acceptance Criteria

- [ ] Neither CI nor Vercel executes `build:test-utils`
- [ ] `NPM_CONFIG_IGNORE_SCRIPTS=true` set at job/process level
- [ ] Resulting `dist/` artefact still contains the WASM + bindings needed for `loadPdk()` (verified by existing `pnpm build` + local smoke)
- [ ] Doc in `docs/payjoin-build.md` calls out that we deliberately do not build upstream test-utils

## Work Log

## Resources

- PR #141
- Upstream script: `vendor/rust-payjoin/payjoin-ffi/javascript/scripts/generate_bindings.sh`
