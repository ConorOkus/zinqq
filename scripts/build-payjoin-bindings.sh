#!/usr/bin/env bash
set -euo pipefail

# Build the Payjoin Dev Kit JS/WASM bindings from the vendored submodule.
# Shared recipe invoked by:
#   - .github/workflows/ci.yml (payjoin-build job)
#   - scripts/vercel-install.sh (Vercel install hook)
#   - pnpm payjoin:build (local dev)
#
# Deliberate divergence from upstream's scripts/generate_bindings.sh:
# we skip `npm run build:test-utils`. test-utils is a napi-rs native test
# helper Zinqq does not consume; its `cd test-utils && npm install` runs
# with lifecycle scripts enabled upstream and would re-introduce the
# unreviewed-upstream-code execution path we're hardening away from.

WASM_BINDGEN_VERSION="0.2.108"
BINDINGS_DIR="vendor/rust-payjoin/payjoin-ffi/javascript"

# Belt-and-suspenders: block upstream lifecycle scripts even if a transitive
# `npm install` sneaks past the outer `npm ci --ignore-scripts` below.
export NPM_CONFIG_IGNORE_SCRIPTS=true

# Pin wasm-bindgen-cli to the version resolved in rust-payjoin's Cargo.lock.
# Version drift surfaces at bind time as a cryptic schema mismatch.
if ! command -v wasm-bindgen >/dev/null \
  || [ "$(wasm-bindgen --version | awk '{print $2}')" != "$WASM_BINDGEN_VERSION" ]; then
  cargo install --locked wasm-bindgen-cli --version "$WASM_BINDGEN_VERSION"
fi

rustup target add wasm32-unknown-unknown

cd "$BINDINGS_DIR"

npm ci --ignore-scripts

# macOS: secp256k1-sys needs a wasm-capable C compiler; Apple's default
# clang can't target wasm32, so point at Homebrew's LLVM.
if [[ "$(uname -s)" == "Darwin" ]]; then
  LLVM_PREFIX=$(brew --prefix llvm)
  export AR="$LLVM_PREFIX/bin/llvm-ar"
  export CC="$LLVM_PREFIX/bin/clang"
fi

# MSRV hack: upstream pins a transitive that breaks under recent Rust.
# Replicated from generate_bindings.sh:18-20.
(cd node_modules/uniffi-bindgen-react-native \
  && cargo add home@=0.5.11 --package uniffi-bindgen-react-native)

npm run build
