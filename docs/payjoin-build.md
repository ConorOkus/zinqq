# Payjoin Dev Kit build

Zinqq vendors the Payjoin Dev Kit (PDK) from [payjoin/rust-payjoin](https://github.com/payjoin/rust-payjoin) as a git submodule under `vendor/rust-payjoin/`. The JavaScript/WASM bindings are built locally — they are not consumed from npm. This keeps the source of truth upstream and avoids a stale npm tarball (`payjoin@0.1.0`, last published Nov 2025).

## Prerequisites

| Tool                                    | Version                                        | Install                                                           |
| --------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| Rust                                    | stable                                         | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| `wasm32-unknown-unknown` target         | —                                              | `rustup target add wasm32-unknown-unknown`                        |
| `wasm-bindgen-cli`                      | **0.2.108** (must match rust-payjoin lockfile) | `cargo install -f wasm-bindgen-cli --version 0.2.108 --locked`    |
| LLVM (macOS only — for `secp256k1-sys`) | latest                                         | `brew install llvm`                                               |

The `wasm-bindgen-cli` version is pinned to whatever rust-payjoin's `Cargo.lock` resolves `wasm-bindgen` to. Version drift produces a schema-mismatch error at bind time. When bumping the submodule, re-check and update this pin.

## One-time setup

```sh
git submodule update --init --recursive
pnpm install
# Install bindings' own npm deps (separate lockfile — not our pnpm)
(cd vendor/rust-payjoin/payjoin-ffi/javascript && npm install)
pnpm payjoin:build
```

`pnpm payjoin:build` runs `vendor/rust-payjoin/payjoin-ffi/javascript/scripts/generate_bindings.sh`, which compiles rust-payjoin to `wasm32-unknown-unknown`, runs `wasm-bindgen`, and produces `dist/` inside the submodule. Zinqq links to that `dist/` via the `"payjoin": "link:./vendor/rust-payjoin/payjoin-ffi/javascript"` dependency.

## Bumping the submodule

```sh
cd vendor/rust-payjoin
git fetch origin
git checkout <new-commit-or-tag>
cd ../..
# Check whether wasm-bindgen pin changed
grep '^name = "wasm-bindgen"' -A 1 vendor/rust-payjoin/Cargo.lock | grep version
# If version changed: reinstall wasm-bindgen-cli at matching version
pnpm payjoin:build
git add vendor/rust-payjoin
```

The submodule commit is part of Zinqq's git history; the built `dist/` is gitignored by upstream and is not committed.

## Troubleshooting

**`failed to find tool "/opt/homebrew/opt/llvm/bin/clang"`** — `brew install llvm` was never run, even though `brew --prefix llvm` prints a path. Brew prints the _expected_ install prefix whether or not the formula is installed.

**`rust Wasm file schema version: 0.2.X; this binary schema version: 0.2.Y`** — wasm-bindgen-cli version doesn't match the `wasm-bindgen` crate version in the submodule's `Cargo.lock`. Reinstall at the matching version.

**Vite can't resolve `payjoin` / empty `dist/`** — if you ran `pnpm install` before `pnpm payjoin:build`, pnpm's `file:` resolution would have honoured the submodule's `"files": ["dist/**/*"]` whitelist against an empty tree. We use `link:` specifically to avoid this — verify your `package.json` entry still reads `"payjoin": "link:./vendor/rust-payjoin/payjoin-ffi/javascript"`.
