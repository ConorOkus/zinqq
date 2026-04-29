---
status: cancelled
priority: p3
issue_id: '249'
tags: [code-review, payjoin, simplicity]
dependencies: ['246']
---

# Drop the wasm-bindgen-cli version-comparison guard in the build script

## Problem Statement

`scripts/build-payjoin-bindings.sh:25-28` runs:

```sh
if ! command -v wasm-bindgen >/dev/null \
  || [ "$(wasm-bindgen --version | awk '{print $2}')" != "$WASM_BINDGEN_VERSION" ]; then
  cargo install --locked wasm-bindgen-cli --version "$WASM_BINDGEN_VERSION"
fi
```

The version comparison adds an `awk` pipeline and a string check on top of a `command -v` guard. Reasoning at write-time: catch a cached binary that's the wrong version. In practice:

- CI cache is keyed on the version string already — a mismatch wouldn't match the cache.
- Vercel installs cold every time.
- Local dev runs once and then caches.

The only realistic case the version comparison catches is "I bumped `WASM_BINDGEN_VERSION` and have an old binary in `~/.cargo/bin/`" — and `cargo install --locked` on the new version would handle that anyway, just noisily.

Composes with todo #246 (drop the cargo bin cache entirely).

## Findings

- `scripts/build-payjoin-bindings.sh:25-28` — version-compare guard.

Flagged by `code-simplicity-reviewer` (P3).

## Proposed Solution

Replace with:

```sh
if ! command -v wasm-bindgen >/dev/null; then
  cargo install --locked wasm-bindgen-cli --version "$WASM_BINDGEN_VERSION"
fi
```

If the existing binary is the wrong version, ubrn's wasm-bindgen schema check fails at build time with an actionable error — same as what surfaced during PR #140 bring-up.

- Effort: Trivial.
- Risk: Low — actionable failure mode if the version drifts.

## Technical Details

- Affected file: `scripts/build-payjoin-bindings.sh`

## Acceptance Criteria

- [ ] Version-compare branch removed
- [ ] CI + local builds still pass

## Work Log

## Resources

- PR #141

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
