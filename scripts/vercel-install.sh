#!/usr/bin/env bash
set -euo pipefail

# Vercel install hook. Bootstraps system-level prereqs (clang for
# secp256k1-sys, Rust toolchain) that GitHub Actions runners already
# have, then delegates the actual Payjoin bindings build to the shared
# scripts/build-payjoin-bindings.sh.
#
# Cold cost: ~8-12 min (rustc install + wasm-bindgen-cli compile +
# rust-payjoin wasm32 build). Subsequent builds may be faster if
# Vercel's build cache preserves ~/.cargo and the submodule's target/.

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

echo "→ Installing Zinqq deps (pnpm)"
pnpm install --frozen-lockfile

echo "→ Building Payjoin bindings"
pnpm payjoin:build

echo "✓ Vercel install complete"
