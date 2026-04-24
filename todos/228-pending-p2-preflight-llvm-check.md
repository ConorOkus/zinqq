---
status: pending
priority: p2
issue_id: '228'
tags: [code-review, payjoin, devx, error-handling]
dependencies: []
---

# Preflight check for llvm in `pnpm payjoin:build`

## Problem Statement

On macOS, `scripts/generate_bindings.sh` uses `$(brew --prefix llvm)` to find clang for `secp256k1-sys`. `brew --prefix llvm` prints `/opt/homebrew/opt/llvm` **whether or not the formula is installed** — so a fresh macOS contributor without llvm gets a deeply-nested `cc-rs` error referring to `/opt/homebrew/opt/llvm/bin/clang: No such file or directory` rather than a clear "please `brew install llvm`."

Already documented in `docs/payjoin-build.md:46-47` under troubleshooting, but preflight prevention beats after-the-fact diagnosis.

## Findings

- `docs/payjoin-build.md:46-47` — documents the exact failure mode, implying it's common.
- `package.json:8` — `payjoin:build` is a bare `cd ... && bash generate_bindings.sh` with no preflight.

Flagged by `agent-native-reviewer` (P2) and corroborated by `kieran-typescript-reviewer` (P3, "fail opaquely").

## Proposed Solution

Wrap `payjoin:build` in a small shell preflight script at `scripts/payjoin-build.sh`:

```sh
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# macOS preflight
if [[ "$(uname -s)" == "Darwin" ]]; then
  if ! [ -x /opt/homebrew/opt/llvm/bin/clang ]; then
    echo "error: llvm not installed. Run: brew install llvm" >&2
    exit 1
  fi
fi

# Submodule preflight
if ! [ -f vendor/rust-payjoin/payjoin-ffi/javascript/scripts/generate_bindings.sh ]; then
  echo "error: rust-payjoin submodule not initialised. Run: git submodule update --init --recursive" >&2
  exit 1
fi

cd vendor/rust-payjoin/payjoin-ffi/javascript
exec bash ./scripts/generate_bindings.sh
```

And update `package.json`:

```json
"payjoin:build": "bash ./scripts/payjoin-build.sh"
```

- Pros: Clear error messages; cheap diagnostics; composable with further preflights (wasm-bindgen version check, Rust target check).
- Cons: One more script to maintain.
- Effort: Small.
- Risk: None.

## Technical Details

- New file: `scripts/payjoin-build.sh` (chmod +x)
- Modified: `package.json:8`

## Acceptance Criteria

- [ ] Fresh macOS without llvm yields a clean error instead of a Rust stack trace
- [ ] Uninitialised submodule yields a clean "git submodule update" hint
- [ ] Existing happy path still succeeds

## Work Log

## Resources

- PR #140
- Hit this failure mode during PR #140 bring-up
