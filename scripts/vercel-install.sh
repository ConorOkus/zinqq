#!/usr/bin/env bash
set -euo pipefail

# Vercel install hook: bootstraps the Rust toolchain, builds the Payjoin
# Dev Kit bindings from the vendored submodule, then runs the normal pnpm
# install. GitHub Actions has a dedicated job for this; Vercel needs it
# inline because there's no multi-job orchestration.
#
# Cold cost: ~8-12 min (rustc install + wasm-bindgen-cli compile +
# rust-payjoin wasm32 build). Subsequent builds may be faster if
# Vercel's build cache preserves ~/.cargo and the submodule's target/.

WASM_BINDGEN_VERSION="0.2.108"

echo "→ Installing clang (secp256k1-sys needs a WASM-capable C compiler)"
if ! command -v clang >/dev/null; then
  dnf install -y clang
fi

echo "→ Installing Rust (if missing)"
if ! command -v cargo >/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain stable --profile minimal
fi
export PATH="$HOME/.cargo/bin:$PATH"

echo "→ Adding wasm32-unknown-unknown target"
rustup target add wasm32-unknown-unknown

echo "→ Installing wasm-bindgen-cli@${WASM_BINDGEN_VERSION} (if missing)"
if ! command -v wasm-bindgen >/dev/null \
  || [ "$(wasm-bindgen --version | awk '{print $2}')" != "$WASM_BINDGEN_VERSION" ]; then
  cargo install --locked wasm-bindgen-cli --version "$WASM_BINDGEN_VERSION"
fi

echo "→ Installing Payjoin bindings npm deps"
(cd vendor/rust-payjoin/payjoin-ffi/javascript && npm ci --ignore-scripts)

echo "→ Installing Zinqq deps (pnpm)"
pnpm install --frozen-lockfile

echo "→ Building Payjoin bindings"
pnpm payjoin:build

echo "✓ Vercel install complete"
