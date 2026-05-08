---
date: 2026-05-07
topic: payjoin-send-npm-package
supersedes: docs/brainstorms/2026-04-23-payjoin-send-brainstorm.md
---

# Payjoin Send (BIP 77 v2) via official `payjoin` npm package

## What We're Building

Re-implement Payjoin **sender** support in Zinqq using the official [`payjoin@0.1.1`](https://www.npmjs.com/package/payjoin) npm package, which was published 2026-05-06 by the rust-payjoin maintainers. When a user pays a BIP 321 URI that includes `pj=`, Zinqq silently coordinates a v2 (BIP 77, OHTTP-relayed) Payjoin exchange with the receiver, validates the proposed PSBT, signs and broadcasts it. On any failure, the original non-Payjoin transaction is broadcast instead so the payment still lands.

The first attempt landed in PRs #139–#144 against a vendored `rust-payjoin` git submodule with a custom WASM build pipeline. It was removed in PR #147 (2026-04-30) pending upstream JS bindings — those bindings are now published as `payjoin@0.1.1`. This brainstorm captures only what's changed since the [original brainstorm](2026-04-23-payjoin-send-brainstorm.md); decisions there are reaffirmed unless noted.

Receiving Payjoin remains out of scope.

## Why This Approach

The `payjoin@0.1.1` npm package is a strict superset of what we need and a strict subset of what we previously built ourselves:

- **Pre-built WASM**: the package ships `dist/web/generated/wasm-bindgen/index_bg.wasm` (~50 MB unpacked, but tree-shaken at bundle time) so we don't compile Rust at all.
- **Vite-friendly entry**: `payjoin/web-vite` uses `import wasmPath from './generated/wasm-bindgen/index_bg.wasm?url'`, which Vite handles natively. No `vite-plugin-wasm`, no top-level-await plugin, no MIME-type Workbox excludes for `.wasm`.
- **Same API surface as PDK 1.0-rc.2**: `Uri.parse → checkPjSupported → new SenderBuilder(psbt, pjUri) → buildRecommended(minFeeRate) → InitialSendTransition.save(persister) → WithReplyKey.createV2PostRequest(ohttpRelay) → processResponse → PollingForProposal.createPollRequest` loop. The previous sender code (`src/onchain/payjoin/payjoin.ts` in PR #143) ports nearly verbatim once the import is swapped.

The architectural insights from the [old plan](../plans/2026-04-23-001-feat-payjoin-send-support-plan.md) — the `transformPsbt` hook, sibling `proposal-validator.ts`, BDK lookahead-extension, claim() sentinel against TOCTOU, `MAX_FEE_SATS` re-check on the proposal — all remain valid and should carry forward into the new plan.

What collapses entirely:

- `vendor/rust-payjoin` submodule, `.gitmodules`
- `scripts/build-payjoin-bindings.sh`, `scripts/vercel-install.sh`
- `payjoin-build` CI job + artifact handoff
- `docs/payjoin-build.md`
- `payjoin: link:vendor/...` dependency entry
- All the WASM-build CI hardening todos (#222–#250 generation)

That's >80% of the original implementation surface area.

## Key Decisions

### Reaffirmed from previous brainstorm (still valid)

- **Scope**: Sender only. v2 (BIP 77) only. `WithReplyKey` in `payjoin@0.1.1` still only exposes `createV2PostRequest` — the `V1Context` type exists but `SenderBuilder` does not produce one. v1 remains a future revisit if upstream re-exposes it.
- **Trigger**: Automatic when `pj=` is present on a BIP 321 on-chain URI. No toggle.
- **Failure policy**: Auto-fallback to broadcasting the original non-Payjoin transaction. `pjos=0` (strict mode) is parsed and logged but not enforced.
- **Session persistence**: In-memory only. If the app closes mid-negotiation, the session is lost; on next send the user falls through to a normal broadcast. No IndexedDB recovery, no "pending Payjoin" UI surface.
- **Architecture**: `transformPsbt: (unsigned, ctx) => Promise<Psbt>` hook on `buildSignBroadcast` rather than a parallel `buildSignBroadcastPayjoin` pipeline. Original PSBT signed unchanged when no hook is present. Fee-sanity (`MAX_FEE_SATS`) check re-runs on the post-Payjoin PSBT automatically.
- **Out of scope**: receive support, multi-party Payjoin, Lightning Payjoin variants, user-facing settings/history.

### New / refined decisions (delta vs previous brainstorm)

- **Library**: `payjoin@0.1.1` from npm (browser entry: `payjoin/web-vite`). Not vendored.
- **Privacy badge on Review screen**: Restore the `Privacy → ● Payjoin` pill that PR #146 added to `src/pages/Send.tsx`. Users see the privacy guarantee before tapping Confirm. On post-confirm fallback, the badge does not lie — the toast on success still says "Sent" generically; only the Send History (future) would distinguish. (Tradeoff: a successful fallback looks identical to a successful Payjoin to the user. Acceptable per "fully silent" intent.)
- **OHTTP relay default**: `https://payjo.in` — the canonical relay maintained by the PDK team and the same one used in 99% of v2 receiver URIs in the wild. No UI to switch. A single env var `VITE_PAYJOIN_OHTTP_RELAY` allows operator override during dev/testing. Hardcoded in production.
- **Kill-switch**: `localStorage.zinqq_payjoin_disabled=1` short-circuits the `transformPsbt` hook and skips PDK load entirely. Incident-response-only — no UI surface. Cheap to ship now, expensive to retrofit if we need to disable Payjoin on prod without a deploy.
- **Lazy load**: `loadPdk()` dynamic-imports `payjoin/web-vite` only when `transformPsbt` is invoked. Zero bundle cost for users who never pay a `pj=` URI. Vite emits the WASM as a separate content-hashed chunk (cached forever).
- **Proxy**: Keep `/api/payjoin-proxy.ts` as a same-origin Edge Runtime forwarder for relay traffic. Browsers cannot rely on `https://payjo.in` permitting cross-origin OHTTP POSTs (the OHTTP CORS posture wasn't probed in the prior cycle and we won't ship without that guarantee). Same SSRF hardening as the previous plan: header allowlist, redirect-disable, private-IP rejection, durable rate-limit, 100KB body cap.
- **CSP**: `connect-src` adds `'self'` only for the proxy. No direct entries for `https://payjo.in` etc. (proxy is same-origin); removes the "operate without a CSP allowlist update per relay" footgun.

## Open Questions (deferred to `/ce:plan`)

- **Fee cap shape**: percentage above original (e.g. 1.5×)? Absolute floor? Both?
- **v2 polling cadence**: foreground poll budget (45s in old plan), backoff curve (1s → 5s in old plan), abort triggers (visibility/beforeunload/unmount).
- **PSBT validation depth**: which of the previous validator's checks (lookahead-aware `is_mine`, sighash preservation, BIP32 derivation equality, sender-input script equality, dust check at 294 sats P2WPKH) carry over verbatim, and whether the npm package now does any of them internally.
- **Telemetry**: which fallback reasons get reported and at what granularity (the old plan settled on 3 buckets: `succeeded` / `fallback_transient` / `fallback_validation`).
- **Vite WASM bundling specifics**: confirm the `?url` import works under our existing `vite-plugin-pwa` Workbox config; check that the WASM chunk doesn't get pre-cached as part of the offline shell.
- **Test vectors**: keep the BTCPay Server v1 cross-test deferred (we ship v2 only); pick a reference v2 receiver to negotiate against in CI/local — likely the rust-payjoin reference receiver running locally.

## Out of Scope (Explicit)

- Receiving Payjoin (reviewer role).
- BIP 78 v1 sender (upstream API not exposed).
- IndexedDB session persistence / cross-reload recovery.
- Enforcing `pjos=0` strict mode at sign time.
- User-facing Payjoin education, settings, or history filters.
- Multi-party / batched Payjoin sends.
- Lightning Payjoin / PayJoin-over-LN variants.

## Next Steps

→ `/ce:plan docs/brainstorms/2026-05-07-payjoin-send-npm-package-brainstorm.md`

The `/ce:plan` deepening should:
1. Pull architectural pieces from the [superseded plan](../plans/2026-04-23-001-feat-payjoin-send-support-plan.md) (transformPsbt hook, proposal-validator, claim() sentinel, BDK lookahead-extension, SSRF-hardened proxy, fee cap, telemetry buckets) and reaffirm or refine each against the npm-package surface.
2. Drop everything related to the build pipeline (CI job, build script, submodule, vercel-install).
3. Verify the `payjoin/web-vite` entry's WASM `?url` import behavior in Vite + vite-plugin-pwa, and document any required Workbox excludes.
4. Lock down the fee cap value and v2 polling cadence.
