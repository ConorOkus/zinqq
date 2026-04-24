---
status: complete
priority: p2
issue_id: '230'
tags: [code-review, payjoin, security, ci, supply-chain]
dependencies: ['224']
---

# Submodule: use `npm ci --ignore-scripts` not `npm install`

## Problem Statement

CI (`.github/workflows/ci.yml:65`) and the developer docs (`docs/payjoin-build.md:21`) both instruct running `npm install` inside the submodule. `npm install` (a) resolves against `package.json` and can drift from `package-lock.json`, and (b) runs all `preinstall` / `prepare` / `postinstall` scripts in the dep tree — including `uniffi-bindgen-react-native`'s `prepare: "yarn build"`.

For a repo whose developer machines also hold wallet seeds in IndexedDB, running arbitrary upstream lifecycle scripts is a real hazard.

## Findings

- `.github/workflows/ci.yml:65` — `npm install` (no lockfile strictness, scripts enabled).
- `docs/payjoin-build.md:21` — `npm install` in the "one-time setup" block.
- `vendor/rust-payjoin/payjoin-ffi/javascript/package-lock.json` exists — `npm ci` is supported.

Flagged by `security-sentinel` (P2).

## Proposed Solution

Change both call sites to `npm ci --ignore-scripts`. If the build then fails because a dep genuinely needs a lifecycle script, document that script explicitly and run it by name — don't re-enable scripts wholesale.

```yaml
# .github/workflows/ci.yml
run: |
  cd vendor/rust-payjoin/payjoin-ffi/javascript
  npm ci --ignore-scripts
  bash ./scripts/generate_bindings.sh
```

```md
<!-- docs/payjoin-build.md -->

(cd vendor/rust-payjoin/payjoin-ffi/javascript && npm ci --ignore-scripts)
```

Composes with finding #224 (`permissions: {}` on the build job).

- Effort: Small.
- Risk: Low — if it breaks, the failure surfaces immediately on next CI run and we can whitelist specific scripts.

## Technical Details

- Affected files: `.github/workflows/ci.yml`, `docs/payjoin-build.md`

## Acceptance Criteria

- [ ] CI uses `npm ci --ignore-scripts`
- [ ] Docs use the same command
- [ ] Build still succeeds (or documents exact scripts that must be re-enabled, with justification)

## Work Log

## Resources

- PR #140
