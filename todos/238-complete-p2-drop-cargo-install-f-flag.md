---
status: complete
priority: p2
issue_id: '238'
tags: [code-review, payjoin, ci, simplicity]
dependencies: []
---

# Drop the `-f` (force) flag on `cargo install wasm-bindgen-cli` in CI

## Problem Statement

`ci.yml:44` runs `cargo install -f wasm-bindgen-cli --version 0.2.108 --locked` — but the preceding `if ! command -v wasm-bindgen >/dev/null` guard already ensures no existing binary is present. The `-f` (force-overwrite) flag is dead.

`scripts/vercel-install.sh:33` uses `cargo install` without `-f` and that's correct.

## Findings

- `.github/workflows/ci.yml:44` — `cargo install -f wasm-bindgen-cli --version 0.2.108 --locked`
- `scripts/vercel-install.sh:33` — `cargo install --locked wasm-bindgen-cli --version "$WASM_BINDGEN_VERSION"` (no `-f`)
- `docs/payjoin-build.md:11` — documented command also has `-f` 

Flagged by `code-simplicity-reviewer` (P2).

## Proposed Solution

Drop `-f` in `ci.yml:44` and `docs/payjoin-build.md:11`.

- Effort: Small.
- Risk: None.

## Technical Details

- Affected files: `.github/workflows/ci.yml`, `docs/payjoin-build.md`

## Acceptance Criteria

- [ ] `-f` removed from both files
- [ ] CI still installs wasm-bindgen-cli on fresh runner

## Work Log

## Resources

- PR #141
