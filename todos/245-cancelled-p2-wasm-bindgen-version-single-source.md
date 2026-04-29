---
status: cancelled
priority: p2
issue_id: '245'
tags: [code-review, payjoin, ci, simplicity]
dependencies: []
---

# Single source of truth for `WASM_BINDGEN_VERSION` between script and CI cache key

## Problem Statement

`scripts/build-payjoin-bindings.sh:16` sets `WASM_BINDGEN_VERSION="0.2.108"` as the canonical pin. `.github/workflows/ci.yml:39` separately hardcodes the same string in the cache key (`wasm-bindgen-cli-0.2.108`). When the script bumps to `0.2.109`, the CI cache key still says `0.2.108` — actions/cache restores the old binary, the script's version check overwrites it locally, and the GHA cache silently never updates. Persistent cache miss, no functional failure.

`docs/payjoin-build.md:11` also hardcodes the version. Three sources of truth.

## Findings

- `scripts/build-payjoin-bindings.sh:16` — `WASM_BINDGEN_VERSION="0.2.108"`
- `.github/workflows/ci.yml:39` — `key: wasm-bindgen-cli-0.2.108`
- `docs/payjoin-build.md:11` — `cargo install --locked wasm-bindgen-cli --version 0.2.108`

Flagged by `architecture-strategist` (P1, downgraded to P2 — failure mode is cache inefficiency not breakage).

## Proposed Solutions

### Option 1 — Sourced env file

Move the pin to `scripts/payjoin-versions.env`:

```sh
WASM_BINDGEN_VERSION=0.2.108
```

Source from the script: `source "$(dirname "$0")/payjoin-versions.env"`. CI step before the cache lookup:

```yaml
- name: Resolve versions
  id: vers
  run: |
    source scripts/payjoin-versions.env
    echo "wasm_bindgen=$WASM_BINDGEN_VERSION" >> "$GITHUB_OUTPUT"

- uses: actions/cache@v4
  with:
    path: ~/.cargo/bin/wasm-bindgen
    key: wasm-bindgen-cli-${{ steps.vers.outputs.wasm_bindgen }}
```

- Pros: One file, sourced by both consumers; survives version bumps cleanly.
- Cons: One more file in `scripts/`.
- Effort: Small.
- Risk: None.

### Option 2 — Print-version flag on the script

`build-payjoin-bindings.sh --print-versions` outputs `WASM_BINDGEN_VERSION=...` for CI to consume. Keeps logic in the script.

- Pros: No extra file.
- Cons: Stretches the script's contract; `set -e` + `exit 0` interplay is fiddly.
- Effort: Small.
- Risk: Low.

### Option 3 — Comment that they must match + relax the cache key

Use a partial cache key that doesn't include the version, plus a runtime version check that forces reinstall on mismatch (already present). Accept that the cache key may carry stale entries until version bumps clear them.

- Pros: Zero changes.
- Cons: Quietly broken cache forever after a bump.
- Effort: None.
- Risk: Medium.

## Recommended Action

Option 1.

## Technical Details

- New: `scripts/payjoin-versions.env`
- Modified: `scripts/build-payjoin-bindings.sh`, `.github/workflows/ci.yml`, `docs/payjoin-build.md`

## Acceptance Criteria

- [ ] `WASM_BINDGEN_VERSION` declared in exactly one file
- [ ] Both script and CI cache key derive from that file
- [ ] Doc references the same value (or links to the file)

## Work Log

## Resources

- PR #141

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
