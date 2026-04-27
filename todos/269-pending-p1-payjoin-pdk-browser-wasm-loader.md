---
status: pending
priority: p1
issue_id: '269'
tags: [code-review, payjoin, wasm, build, ci]
dependencies: []
---

# Wire a real browser-compatible PDK WASM loader

## Problem Statement

PR #143 was forced to ship `loadPdk()` as a hard rejection because the
vendored PDK build (`payjoin-1.0.0-rc.2`) has a broken browser entry.
Specifically:

- `dist/index.web.js` imports a wasm-bindgen loader that was generated
  with `--target nodejs` (via `ubrn build web --and-generate`).
- The Node-target loader (`src/generated/wasm-bindgen/index.js`) uses
  `require('fs').readFileSync(${__dirname}/index_bg.wasm)` to load the
  wasm bytes — Node-only and unbundleable.
- The Node target also doesn't produce the `index_bg.js` companion file
  that vite-plugin-wasm needs when bundling. Vite's production build
  (`tsc -b && vite build`) fails with
  `Could not resolve "./index_bg.js" from "...index_bg.wasm"`.
- `dist/index.web.js` calls `initAsync({ module_or_path: wasmPath })`
  but the imported loader doesn't accept any arguments — even if the
  bundle resolved, it would fail at runtime.

Net effect: there is no working browser entry into PDK at the current
pinned tag. Every `tryPayjoinSend` falls back through the `pdk_load`
fallback path, broadcasts the original PSBT, and Payjoin coordination
never actually happens in production.

## Findings

- Detected during /ce:review iteration on PR #143; Vercel build failed.
- `pnpm build` reproduces the error locally.
- BDK (`@bitcoindevkit/bdk-wallet-web`) ships `--target bundler`-style
  output (`bitcoindevkit_bg.{wasm,js}` + matching companion JS) and works
  with vite-plugin-wasm. PDK's output would too if the target were
  `--target web` or `--target bundler`.
- Upstream `ubrn build web` does not expose a `--target` parameter; the
  Node target appears hardcoded inside ubrn.

## Proposed Solutions

### Option 1 — Re-emit wasm-bindgen with `--target web` after `ubrn build`

Add a step to `scripts/build-payjoin-bindings.sh` that runs after
`npm run build`:

```sh
# Overwrite ubrn's --target nodejs output with a --target web build
# from the same source. Produces index.js + index_bg.js + index_bg.wasm
# that vite-plugin-wasm can consume.
wasm-bindgen \
  --target web \
  --out-dir "$BINDINGS_DIR/src/generated/wasm-bindgen" \
  --out-name index \
  rust_modules/wasm/target/wasm32-unknown-unknown/.../payjoin.wasm
```

Then patch `dist/index.web.js` to use the rebuilt loader (or accept the
existing `module_or_path` arg shape).

- Pros: keeps the upstream build intact; layered fix.
- Cons: needs the same wasm input file that ubrn used; needs to know the
  output path; doubles wasm-bindgen invocation time.

### Option 2 — Build PDK ourselves bypassing ubrn

Skip `ubrn build web` entirely. Run `cargo build -p payjoin-ffi --target
wasm32-unknown-unknown --features send,v1,v2 --no-default-features` then
`wasm-bindgen --target web` directly. Drop all of upstream's TS-side
glue and write our own thin wrapper.

- Pros: full control; matches the plan's original direction (§370).
- Cons: more code we maintain; loses upstream's TS bindings.

### Option 3 — Wait for upstream to ship a fixed browser build

File an issue against `payjoin/rust-payjoin` and `pace-r/uniffi-bindgen-react-native`
(or whoever owns the ubrn web target). Ship Phase 3 with the stub for
now. Expect weeks-to-months.

- Pros: no new code we maintain.
- Cons: Payjoin doesn't actually work for that whole period.

### Option 4 — Use a runtime-fetch loader

Serve `index_bg.wasm` as a static asset (under `/public/`) and write a
small browser-only loader that fetches and instantiates via
`WebAssembly.instantiateStreaming`, then exposes the bindings the way
PDK's TS layer expects.

- Pros: avoids vite-plugin-wasm entirely for PDK; clean separation.
- Cons: re-implements the wasm-bindgen runtime glue (refs, memory views,
  externref tables) — a lot of code to get right.

## Recommended Action

Option 1 first. It's the smallest change that produces a bundleable
output. If upstream changes invalidate the patch, re-evaluate.

## Technical Details

- Affected files:
  - `scripts/build-payjoin-bindings.sh` — add post-ubrn `wasm-bindgen --target web` step
  - `src/onchain/payjoin/pdk.ts` — replace the rejection stub with the real `import('payjoin')` + `mod.uniffiInitAsync()` chain
  - `src/onchain/payjoin/pdk.test.ts` — restore the memoization tests
- May require: patching `dist/index.web.js` post-build OR adding a thin re-export shim file under `vendor/.../javascript/dist-web/` that we reference via a `resolve.alias` in `vite.config.ts`.

## Acceptance Criteria

- [ ] `pnpm build` succeeds with PDK actually loaded into the bundle
- [ ] `loadPdk()` resolves to the PDK namespace at runtime in a browser
- [ ] An end-to-end test (manual is fine for first cut) confirms a v2 Payjoin negotiation reaches the OHTTP relay POST step
- [ ] CI Vercel deploy passes

## Work Log

## Resources

- PR #143
- PDK source: `vendor/rust-payjoin/payjoin-ffi/javascript/dist/index.web.js`
- wasm-bindgen targets: https://rustwasm.github.io/docs/wasm-bindgen/reference/deployment.html
- Plan: `docs/plans/2026-04-23-001-feat-payjoin-send-support-plan.md` (§370 — original WASM build direction)
