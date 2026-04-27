---
title: Payjoin Send Support (BIP 77 v2 only)
type: feat
status: active
date: 2026-04-23
origin: docs/brainstorms/2026-04-23-payjoin-send-brainstorm.md
---

# Payjoin Send Support (BIP 77 v2 only)

> **Scope revision (2026-04-26):** v1 (BIP 78) was dropped from this plan after PDK 1.0-rc.2 was found not to expose a v1 sender path in its JS bindings (`SenderBuilder` only routes through `WithReplyKey.createV2PostRequest`; `V1Context` is defined but never produced). Decision: ship v2 first, treat v1 as a future revisit only if upstream re-exposes it. v1-specific sections below (`/api/payjoin-proxy` v1 routing, `additionalfeeoutputindex`, `maxadditionalfeecontribution` build params, the v1+v2 dual-path branch) are out-of-scope. The transformPsbt/abort/telemetry/validator infra remains intact.

## Enhancement Summary

**Deepened on:** 2026-04-23 (same day as initial plan — deepening triggered by ultrathink auto-run)

**Agents engaged:** security-sentinel, kieran-typescript-reviewer, architecture-strategist, code-simplicity-reviewer, performance-oracle, julik-frontend-races-reviewer, pattern-recognition-specialist, data-integrity-guardian, best-practices-researcher, Explore (verification pass).

### Critical corrections applied (inline fixes to plan)

1. **v2 URL scheme guard**: `parseBip321` snippet previously required `url.protocol === 'https:'`, which would silently drop every BIP 77 URI (v2 uses `bitcoin:`/`payjoin:` payload schemes inside `pj=`). Fix: defer scheme validation to PDK's URI parser; reject only obviously-malformed values at our layer.
2. **`MIN_FEE_RATE_SAT_VB` location**: verified at `src/onchain/context.tsx:31` (not 186-190) and **not exported**. Promote it — plus `MAX_FEE_SATS` — to `src/onchain/config.ts` and export; Payjoin code imports from there.
3. **Test file placement**: drop proposed `src/onchain/payjoin/__tests__/` subdir. 100% of existing tests are sibling `*.test.ts`; `__tests__/` is a zero-occurrence pattern. Place Payjoin tests as `sender.test.ts`, `validate.test.ts`, etc., next to their source files.
4. **Serverless proxy signature**: `api/payjoin-proxy.ts` must use Web Fetch API (`export async function POST(request: Request): Promise<Response>`) to match `api/lnurl-proxy.ts` and `api/esplora-proxy.ts`. The initial plan snippet used Express-style `(req, res)` — inconsistent.
5. **Proxy query param**: use `_path` (existing convention) not `_url`.
6. **Verify npm availability before vendoring**: research flagged that the `payjoin` npm package may now be published. Run `npm view payjoin versions dist-tags` as the first step of Phase 3; if the published artifact covers our WASM target, skip vendoring entirely. Vendoring strategy becomes Plan B, not Plan A.

### New considerations discovered

- **SSRF hardening required on proxy** (private IP rejection, redirect disabling, DNS-rebinding mitigation, non-default port rejection, inbound header allowlist, durable rate-limit via Vercel KV/Upstash — in-memory rate limit is per-instance and useless).
- **BDK `is_mine()` lookahead gap**: a malicious receiver could propose a UTXO at `derivation_index > last_revealed + lookahead` and `is_mine` returns false even though the script is ours. Extend lookahead to ≥1000 (ephemerally) before validation, then revert.
- **Late-proposal TOCTOU**: `abortSignal.aborted` check is insufficient — races between check and `wallet.sign`. Need an atomic single-writer `claim()` sentinel to rule out double-broadcast.
- **Double-pause bug if fallback nests `buildSignBroadcast`**: fix by routing fallback through a shared `finalizeAndBroadcast(tx)` only — never nested.
- **Additional PSBT validation**: sighash preservation, non-witness UTXO stripping on segwit inputs, BIP32 derivation path equality, witness/redeem script equality on sender inputs, taproot-specific checks.
- **Architectural cleaner alternative**: add an optional `transformPsbt: (unsigned, ctx) => Promise<Psbt>` hook to existing `buildSignBroadcast` instead of forking into `buildSignBroadcastPayjoin`. Zero duplication of the broadcast tail; `MAX_FEE_SATS` sanity check automatically re-runs on the proposal. **Plan decision**: adopt this; retire the `buildSignBroadcastPayjoin` proposal.
- **Runtime kill switch**: add `localStorage.zinqq_payjoin_disabled=1` — incident-response flag, cheap to ship alongside `zinqq_payjoin_debug`.
- **Proxy should use Vercel Edge Runtime** (10-50ms coldstart vs 200-800ms for Node).
- **Zinqq is P2WPKH-only (BIP84)**: dust check simplifies to 294 sats against change output; delete the P2PKH branch and fix the P2TR number to 330 (was 294/302 in draft).
- **`wallet.apply_unconfirmed_txs([proposalTx])` required before reading balance** on Payjoin success — BDK didn't build the proposal tx, so its balance won't reflect the spend until a sync round-trips.
- **OHTTP CORS posture unknown** on the three named relays — empirical probe required before relying on browser-direct; fall back to proxying v2 traffic through `/api/payjoin-proxy` as well.
- **v2 foreground poll bumped to 45s** (was 30s). OHTTP round-trips are 500ms–3s each, and cooperating receivers with human-in-the-loop commonly take 10-25s.
- **Fallback reason taxonomy narrows for telemetry**: 7 classes → 3 (`succeeded`, `fallback_transient`, `fallback_validation`). Fine-grained classes remain in the debug console; aggregated telemetry protects against receiver fingerprinting.
- **Telemetry wiring**: route through existing `captureError` primitive (`src/storage/error-log.ts`) as `captureError('info', 'Payjoin', …)`. Don't introduce a parallel analytics layer for one feature.
- **Simplicity pass**: collapse 5 proposed modules (`sender.ts` + `validate.ts` + `pdk-loader.ts` + `telemetry.ts` + `pdk-wasm/`) to one `payjoin.ts` + `proposal-validator.ts` + the PDK submodule until separation earns independence. Telemetry inlines at call sites.

### Key improvements

1. Architecture: one `transformPsbt` hook eliminates pipeline fork.
2. Security: SSRF-hardened proxy, header allowlist, durable rate-limit, extended PSBT validation, lookahead-aware ownership check.
3. Correctness: v2 URL scheme fix (v2 wasn't reachable as originally drafted).
4. Codebase alignment: test sibling pattern, Web `Request/Response` handler, `_path` param, constants in `config.ts`, telemetry via `captureError`.
5. Performance: Edge Runtime proxy, `compileStreaming`, content-hashed WASM filename, feature-gated PDK build (v1+v2+send only), speculative parallel PDK load.
6. Race safety: `claim()` sentinel, composed `AbortSignal.any`, no nested `pause/resume`, explicit v2 poll cadence (recursive `setTimeout`, 1s→5s backoff).

## Overview

Teach Zinqq to send Payjoin transactions. When a user pays a BIP 321 URI that advertises `pj=`, Zinqq silently coordinates with the receiver to produce a transaction in which both parties contribute inputs. This breaks the common-input-ownership heuristic used by chain analysis tools, improving the user's on-chain privacy with zero change to their workflow. Receiving Payjoin is explicitly out of scope.

Protocol support: **BIP 78 (v1, synchronous)** and **BIP 77 (v2, async via OHTTP + directory)** — shipped together. Implementation uses the **Payjoin Dev Kit (rust-payjoin)** compiled to WebAssembly and loaded lazily on the send path.

## Problem Statement / Motivation

Today, any BIP 321 URI with a `pj=` parameter is silently ignored by `parseBip321()` in `src/ldk/payment-input.ts:195-249`. This means:

- **Privacy loss**: Every on-chain send reveals "inputs A+B and outputs X+Y all belong to the sender" — the common-input-ownership heuristic lets chain surveillance cluster a user's entire wallet after one payment.
- **Ecosystem parity**: BTCPay Server, Wasabi, Sparrow, BlueWallet, and (as of 2025) Bull Bitcoin all ship Payjoin. Not supporting it marks Zinqq as a lower-tier wallet.
- **No cost to opt in**: Payjoin is backwards-compatible. If the receiver doesn't support it, the sender falls back to a normal broadcast. There is no user-facing downside to supporting it.

The brainstorm's dual motivation — _privacy by default_ and _opportunistic compatibility_ — maps directly to: "if `pj=` is present, use it; otherwise act as today."

## Proposed Solution

Extend the on-chain send pipeline with an optional Payjoin path that executes between "build PSBT" and "sign & broadcast."

```
                 URI contains pj=?
                         │
                         ▼
              buildSignBroadcast(buildPsbt, feeRate, transformPsbt?)
                         │
                         ├─ build original PSBT (unsigned)
                         ├─ if transformPsbt (Payjoin path):
                         │     psbtToSign = await tryPayjoinSend(original, …)
                         │       • kill-switch + pre-flight checks
                         │       • lazy-load PDK WASM
                         │       • PDK sender exchange:
                         │           v1 → POST through /api/payjoin-proxy
                         │           v2 → OHTTP via payjo.in directory
                         │       • proposal-validator.ts post-checks
                         │       • returns proposal PSBT on success,
                         │         or throws on failure (→ fallback to original)
                         │   else:
                         │     psbtToSign = original
                         ├─ MAX_FEE_SATS sanity check
                         ├─ wallet.sign(psbtToSign)
                         ├─ if Payjoin path: wallet.apply_unconfirmed_txs([tx])
                         └─ finalizeAndBroadcast(tx): broadcast, persist, sync
```

All existing non-Payjoin sends are untouched. The Payjoin path is a dynamic, lazy-loaded branch that costs zero bundle weight and zero latency when not triggered.

## Technical Approach

### Architecture

New modules (consolidated per simplicity review — start with 2 files, split when a second caller exists):

- `src/onchain/payjoin/payjoin.ts` — combined sender + lazy PDK loader. Exports `tryPayjoinSend(originalPsbt, payjoinCtx, wallet, signal)` and `loadPdk()`. Dynamic-imports the PDK submodule only when invoked. PDK load failures and telemetry events are routed through the existing `captureError` primitive (`src/storage/error-log.ts`).
- `src/onchain/payjoin/proposal-validator.ts` — sender-side post-PDK checks: lookahead-aware `wallet.is_mine()` over every receiver-added input, P2WPKH dust check (294 sats), change-delta cap, sighash/derivation/script preservation on sender inputs. Pure function, fully unit-testable.
- `src/onchain/payjoin/pdk-wasm/` — vendored PDK WASM (only if npm `payjoin` does not cover our WASM target; see Phase 3).
- `api/payjoin-proxy.ts` — Vercel Edge Runtime serverless endpoint (`export const config = { runtime: 'edge' }`): POST-capable, Web `Request`→`Response` signature matching `api/lnurl-proxy.ts`, body-forwarding, header allowlist, 20s timeout, 100 KB body cap, durable per-IP rate limit via Vercel KV.
- Tests are sibling `*.test.ts` (no `__tests__/` subdir — not a convention in this repo): `src/onchain/payjoin/payjoin.test.ts`, `src/onchain/payjoin/proposal-validator.test.ts`.

Modified modules:

- `src/ldk/payment-input.ts:26-49` — extend `ParsedPaymentInput` `onchain` variant with optional `payjoin: { url: string; strict: boolean }` field. Extend `parseBip321()` at 195-249 to extract `pj=` and `pjos=`. Capture the raw `pj=` value (no scheme validation at this layer — defer to PDK).
- `src/ldk/payment-input.test.ts` — add tests for `pj=`, `pjos=`, case-insensitivity, empty values.
- `src/onchain/config.ts` — **hoist** `MIN_FEE_RATE_SAT_VB` and `MAX_FEE_SATS` from their current private home in `src/onchain/context.tsx:31` into `ONCHAIN_CONFIG` exports. Payjoin code imports from `config.ts`, not `context.tsx`.
- `src/onchain/context.tsx:177-236` — grow `buildSignBroadcast` with an optional third parameter `transformPsbt?: (unsigned: Psbt, ctx: { wallet: Wallet, feeRate: bigint, signal: AbortSignal }) => Promise<Psbt>`. If provided, it runs between the PSBT build and `wallet.sign`. Fee-sanity check (`MAX_FEE_SATS`) runs on the transformed PSBT automatically. On throw, caller surfaces via `mapSendError`. On return-unchanged, the original PSBT is signed (declined pre-flight, no telemetry). Extract `finalizeAndBroadcast(tx)` as the single broadcast tail used by both paths — **never nested**.
- `src/pages/Send.tsx:869-907` (review screen) — unchanged rendering. In `handleOcConfirm`, pass a `transformPsbt` function to `sendToAddress` when `parsed.payjoin` is present, `sendMax` never gets one. Wire a `useRef<AbortController>` tied to `visibilitychange` + `beforeunload` + unmount.
- `vite.config.ts:14-50` — dev proxy gains `/__payjoin_proxy/DOMAIN/PATH` handler mirroring production behavior (same `_path` rewrite convention as `lnurl-proxy`).
- `vite.config.ts:85-103` (VitePWA / Workbox) — add runtime caching exclusion for `payjo.in`, the three OHTTP relays, and `/api/payjoin-proxy`. PDK WASM served with content-hashed filename; `Cache-Control: public, max-age=31536000, immutable`.
- `vercel.json` — add CSP with an **explicit `connect-src` allowlist**: `'self' https://payjo.in https://pj.benalleng.com https://pj.bobspacebkk.com https://ohttp.achow101.com`. v1 traffic goes through `/api/payjoin-proxy` which is same-origin, so no broad `https:` fallback needed.

### Components

#### 1. URI Parser — `src/ldk/payment-input.ts`

Extend `ParsedPaymentInput`:

```typescript
// src/ldk/payment-input.ts:26-49
export type PayjoinContext = {
  url: string        // https URL for v1 OR bitcoin://payjo.in/… for v2
  strict: boolean    // true if pjos=0 (currently ignored at runtime)
}

export type ParsedPaymentInput =
  | /* existing variants unchanged */
  | {
      type: 'onchain'
      address: string
      amountSats: bigint | null
      payjoin?: PayjoinContext   // NEW: optional field
    }
  | /* … */
```

Extend `parseBip321()`:

```typescript
// src/ldk/payment-input.ts:195-249
function parseBip321(input: string): ParsedPaymentInput {
  // … existing extraction of address, amount, lno, lightning …

  let payjoin: PayjoinContext | undefined
  const pjRaw = getCaseInsensitive(params, 'pj')
  const pjosRaw = getCaseInsensitive(params, 'pjos')
  if (pjRaw && typeof pjRaw === 'string' && pjRaw.length > 0 && pjRaw.length < 2048) {
    // CORRECTION: do NOT require https here — BIP 77 (v2) uses bitcoin://
    // or payjoin:// inside pj=. Defer real scheme validation to PDK's
    // URI parser during the send path. Reject only length/empty here.
    payjoin = { url: pjRaw, strict: pjosRaw === '0' }
  }

  // Lightning takes precedence over on-chain per existing logic; payjoin
  // only attaches to the on-chain branch.
  return { type: 'onchain', address, amountSats, payjoin }
}
```

> **Correction note**: an earlier draft of this snippet enforced `url.protocol === 'https:'` at the parser layer. That would have silently dropped every BIP 77 v2 URI. Scheme/shape validation belongs inside PDK's `parseUri`, which understands v1 (https) _and_ v2 (`bitcoin:`/`payjoin:`) shapes. Parser's job is to capture the raw value; PDK's job is to reject invalid shapes with a `validation` fallback reason.

Test cases added to `src/ldk/payment-input.test.ts`:

- `pj=https://btcpay.example/payjoin/xyz` → attached
- `PJ=https://…` (case-insensitive) → attached
- `pj=http://…` → silently dropped
- `pj=` malformed → silently dropped
- `pj=…&pjos=0` → `strict: true` attached
- Both `pj=` and `lightning=` present → Lightning wins; `payjoin` not attached (on-chain branch not reached)

#### 2. Payjoin Sender — `src/onchain/payjoin/payjoin.ts`

```typescript
// src/onchain/payjoin/payjoin.ts
import { MIN_FEE_RATE_SAT_VB, MAX_FEE_SATS } from '../config'

// Single authoritative source of fallback reasons.
export const FALLBACK_REASONS = {
  network: 'network',
  timeout: 'timeout',
  validation: 'validation',
  pdkLoad: 'pdk_load',
  proxy: 'proxy',
  pdkError: 'pdk_error',
  backgrounded: 'backgrounded',
  unknown: 'unknown',
} as const satisfies Record<string, string>
export type FallbackReason = (typeof FALLBACK_REASONS)[keyof typeof FALLBACK_REASONS]

// Telemetry collapses fine-grained reasons into 3 buckets to prevent
// receiver fingerprinting. Fine-grained reason stays in debug console.
export const TELEMETRY_BUCKETS = {
  succeeded: 'payjoin_succeeded',
  fallback_transient: 'payjoin_fallback_transient', // network/timeout/proxy/pdk_load/pdk_error/backgrounded/unknown
  fallback_validation: 'payjoin_fallback_validation', // hostile-receiver signal
} as const

// `tryPayjoinSend` is invoked as a `transformPsbt` hook from buildSignBroadcast:
//   throw  → signals a failed attempt; caller's mapSendError surfaces to user telemetry is emitted
//   return unchanged original PSBT → declined pre-flight (sendMax, single UTXO, disabled flag); no telemetry
//   return modified proposal PSBT  → Payjoin succeeded; buildSignBroadcast signs + broadcasts it
export async function tryPayjoinSend(
  originalPsbt: Psbt,
  payjoinCtx: PayjoinContext,
  ctx: { wallet: Wallet; feeRate: bigint; signal: AbortSignal }
): Promise<Psbt> {
  // 0. Kill switch
  if (localStorage.getItem('zinqq_payjoin_disabled') === '1') return originalPsbt

  // 1. Pre-flight: skip if sendMax (no change output), single UTXO, or
  //    originalFee + (feeRate * 110) > MAX_FEE_SATS.
  //    Return originalPsbt unchanged (no attempt, no telemetry).

  // 2. Dynamic-import PDK (speculative parallel load is a post-ship optimisation).

  // 3. Construct Sender via PDK:
  //    - maxAdditionalFeeContribution = feeRate * 110       // BIP 78 canonical
  //    - additionalFeeOutputIndex = index of change output
  //    - minFeeRate = MIN_FEE_RATE_SAT_VB                    // always set
  //    - v=1

  // 4. Send request (v1: POST via /api/payjoin-proxy, 15s timeout)
  //               (v2: OHTTP via directory, foreground poll 45s, exponential backoff 1s→5s)
  //    Signal composition: AbortSignal.any([ctx.signal, AbortSignal.timeout(...)])

  // 5. Receive proposal PSBT.

  // 6. PDK validates (signatures, BIP 78 invariants).

  // 7. Our proposal-validator.ts post-checks (lookahead-aware is_mine, dust, change-delta,
  //    sighash/derivation/script preservation on sender inputs).

  // 8. claim('payjoin') — atomic sentinel.

  // 9. Return proposal PSBT. buildSignBroadcast signs it + runs MAX_FEE_SATS
  //    sanity check + broadcasts via shared finalizeAndBroadcast.

  // Any throw/abort: caller treats as failed attempt. discardStagedChanges(wallet)
  // before rethrow. Fallback signs + broadcasts the originalPsbt via the SAME
  // buildSignBroadcast call — no nested pause/resume.
}
```

Telemetry events fire through `captureError` (existing primitive at `src/storage/error-log.ts`), bucketed into the 3 classes in `TELEMETRY_BUCKETS`. The fine-grained `FallbackReason` value is written only to the debug console behind `localStorage.zinqq_payjoin_debug=1` (see Observability).

#### 3. Receiver Proposal Validation — `src/onchain/payjoin/proposal-validator.ts`

PDK enforces BIP 78 §"Sender's Payjoin proposal checklist" (version/locktime, input/output preservation, absolute fee non-decrease, feerate ≥ `minFeeRate`, fee contribution ≤ `maxAdditionalFeeContribution`). On top of that we enforce:

```typescript
// src/onchain/payjoin/proposal-validator.ts
export function validateProposal(
  proposal: Psbt,
  original: Psbt,
  wallet: Wallet,
  originalFeeRate: bigint
): ValidationResult {
  // a) Lookahead-aware ownership check. Temporarily extend keychain lookahead
  //    (reveal_addresses_to, external + internal; +100 indices is enough given
  //    our BIP84 wpkh descriptor; 1000 in the first review was cargo-culted).
  //    Run wallet.is_mine(scriptPubkey) over every receiver-added input.
  //    Revert via discardStagedChanges(wallet) before returning.
  //    Zero receiver-added inputs may be ours.
  //
  // b) Zinqq is BIP84 P2WPKH-only (src/wallet/keys.ts:67-82). Change output
  //    MUST be >= 294 sats. Payment output dust is the receiver's concern.
  //
  // c) Change-delta cap: original.changeOutput.value - proposal.changeOutput.value
  //    MUST be <= originalFeeRate * 110. (Defense-in-depth; PDK also checks.)
  //
  // d) Sender-input preservation (byte-equal to original):
  //    - sighash_type
  //    - bip32_derivation map
  //    - witness_script / redeem_script fields
  //    - tap_key_sig / tap_script_sig / tap_merkle_root / tap_leaf_script
  //    - No non_witness_utxo added on segwit inputs.
  //    - Sender change output scriptPubKey byte-equal to original.
  //
  // e) Strip global xpub / proprietary fields from proposal before signing.
}
```

> Note: DNS-rebinding mitigation and SLSA 3 attestation were proposed during deepening but demoted as overkill for first ship. The SHA-256 manifest + CODEOWNERS rule on submodule bumps is the chosen supply-chain posture (see Risk Analysis).

#### 4. Serverless Proxy — `api/payjoin-proxy.ts`

Modeled on `api/lnurl-proxy.ts` (GET-only, 43 lines) but POST-capable.

```typescript
// api/payjoin-proxy.ts
const ALLOWED_HOSTS = [
  'payjo.in',
  'pj.benalleng.com',
  'pj.bobspacebkk.com',
  'ohttp.achow101.com',
  // v1 endpoints: allow any host (receiver-chosen). Validate scheme only.
]

const ALLOWED_CONTENT_TYPES = [
  'text/plain', // v1 PSBT base64
  'message/ohttp-req', // v2 OHTTP encapsulated request
  'application/octet-stream', // some v1 receivers
]

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const target = req.query._url as string
  const targetUrl = parseAndValidate(target) // scheme=https, length bound
  if (!targetUrl) return res.status(400).end()

  const bodyLen = Number(req.headers['content-length'] ?? 0)
  if (bodyLen > 100 * 1024) return res.status(413).end()

  const ctype = req.headers['content-type']
  if (!ALLOWED_CONTENT_TYPES.some((a) => ctype?.startsWith(a))) return res.status(415).end()

  // 20s upstream timeout (longer than v2's 15s foreground budget to allow
  // directory handoff; v1 sender times out its own fetch at 15s).
  const upstream = await fetchWithTimeout(targetUrl, {
    method: 'POST',
    headers: { 'content-type': ctype! },
    body: req, // stream-forward
    signal: AbortSignal.timeout(20_000),
  })

  res.status(upstream.status)
  res.setHeader('content-type', upstream.headers.get('content-type') ?? 'text/plain')
  res.send(await upstream.text())
}
```

Security controls: rate limit per IP (Vercel Edge Config or lightweight in-memory), no body logging, strip `X-Forwarded-For` from upstream request.

#### 5. Lazy PDK Loader — `src/onchain/payjoin/pdk-loader.ts`

```typescript
// src/onchain/payjoin/pdk-loader.ts
let pdkPromise: Promise<PdkModule> | null = null

export function loadPdk(): Promise<PdkModule> {
  if (!pdkPromise) {
    pdkPromise = import('./pdk-wasm')
      .then(async (m) => {
        await m.uniffiInitAsync()
        return m
      })
      .catch((err) => {
        pdkPromise = null
        throw err
      })
  }
  return pdkPromise
}
```

Vendoring strategy: **first step is `npm view payjoin versions dist-tags`**. Research flagged that the `payjoin` package may now be published on npm; if the published artifact covers our WASM target, we skip vendoring entirely and use a normal dependency. If vendoring is still required:

1. Add a git submodule or snapshot of `github.com/payjoin/rust-payjoin` at a pinned SHA.
2. Build via `cargo build -p payjoin-ffi --target wasm32-unknown-unknown --features send,v1,v2 --no-default-features` (drops `receive`, directory, relay) + `wasm-bindgen-cli` + `wasm-opt -Oz -g0`. Output to `src/onchain/payjoin/pdk-wasm/` (gitignored). `rust-toolchain.toml` pin + `Cargo.lock` + `--locked --frozen` for reproducibility.
3. Check in a `pdk-wasm.manifest.json` containing source repo, commit SHA, build args, SHA-256 of the produced `.wasm`. CI verifies the manifest matches a fresh build on every PR.
4. `CODEOWNERS` rule routes submodule bumps to a security reviewer. Two-person rule for bumps.
5. Update cadence: **on-demand for security advisories; review monthly otherwise**.

> SLSA Level 3 attestation was proposed during deepening; demoted as overkill for first ship. SHA-256 manifest + CODEOWNERS covers the realistic threat.

### Implementation Phases

Consolidated to 4 phases per architecture + simplicity reviews.

#### Phase 1: Scaffolding (URI parser, proxy, dev infra)

- Extend `ParsedPaymentInput.onchain` with optional `payjoin` field; `parseBip321()` extracts `pj=` and `pjos=` (raw capture, no scheme validation).
- Sibling unit tests in `src/ldk/payment-input.test.ts`.
- Author `api/payjoin-proxy.ts` — Edge Runtime, Web `Request`→`Response`, `_path` param, POST-only, header allowlist, host allowlist for v2 relays, private-IP rejection post-DNS-resolve, 100 KB body cap, durable per-IP rate limit via Vercel KV, 20s timeout, `redirect: 'manual'`.
- Dev proxy `/__payjoin_proxy/DOMAIN/PATH` in `vite.config.ts`.
- `vercel.json` CSP with explicit `connect-src` allowlist.
- Hoist `MIN_FEE_RATE_SAT_VB` and `MAX_FEE_SATS` into `src/onchain/config.ts`; update imports.
- **Deliverable**: URIs parse, proxy smoke-tested, constants hoisted; downstream behavior unchanged.
- **Effort**: ~1.5 days

#### Phase 2: PDK integration

- Run `npm view payjoin` — if published with our target, install normally; else vendor via submodule + SHA-256 manifest.
- Implement `loadPdk()` (memoised dynamic import + `uniffiInitAsync`) inside `src/onchain/payjoin/payjoin.ts`.
- Bundle-size CI gate (main chunk unchanged ±2 KB; PDK chunk ≤ 1.2 MB gzip).
- Content-hashed WASM filename; `WebAssembly.compileStreaming`.
- **Deliverable**: `loadPdk()` returns a functional PDK in a test harness; bundle gates green.
- **Effort**: ~1.5 days

#### Phase 3: v1 sender + validator + wiring

- Implement `tryPayjoinSend` (v1 path) and `validateProposal`.
- Grow `buildSignBroadcast` with optional `transformPsbt` hook; extract `finalizeAndBroadcast(tx)`.
- Wire `Send.tsx:handleOcConfirm` to pass `tryPayjoinSend` as the hook when `parsed.payjoin` is present and not `sendMax`. Add `useRef<AbortController>` with `visibilitychange` + `beforeunload` + unmount handlers.
- Pre-flight skips: `sendMax`, single UTXO, fee cap > `MAX_FEE_SATS`, kill-switch enabled.
- Telemetry via `captureError` with 3 buckets.
- Atomic `claim()` sentinel; `discardStagedChanges` on every non-success exit.
- Tests: happy path (mock PDK), each fallback bucket, `sendMax` skip, kill-switch active.
- **Deliverable**: v1 Payjoin send succeeds end-to-end against `payjoin-cli` on regtest via nigiri.
- **Effort**: ~2 days

#### Phase 4: v2 + observability + ship

- v2 code path in `tryPayjoinSend` via PDK's `SenderBuilder` v2 API.
- OHTTP relay selection: ordered fallback across 3 relays.
- 45s v2 foreground poll; recursive `setTimeout` with backoff 1s→5s; abort-aware `sleep`.
- Cancel on: `claim()` taken, tab hidden 30s (`visibilitychange`), user navigates (`beforeunload`), unmount.
- Workbox allowlist for `payjo.in`, 3 relays, `/api/payjoin-proxy`.
- `localStorage.zinqq_payjoin_debug=1` exposes fine-grained `FallbackReason` via `console.info`.
- `localStorage.zinqq_payjoin_disabled=1` kill-switch tested (skip branch entirely, no PDK load).
- README update + `docs/solutions/` notes.
- Manual mainnet verification against live BTCPay Server.
- **Deliverable**: v2 send succeeds against `payjo.in` + regtest receiver; production-ready.
- **Effort**: ~2 days

**Total estimate**: ~7 engineer-days.

## Alternative Approaches Considered

### A. Pure-TypeScript v1-only implementation

Hand-roll BIP 78: POST base64 PSBT with query params, parse response, validate against the BIP 78 checklist. No WASM.

- **Pros**: no vendored unreleased code; bundle ~20 KB instead of ~1 MB; zero supply-chain risk beyond our own code.
- **Cons**: we re-implement sender-side validation (subtle, many edge cases; documented bugs in Sparrow and BTCPay from getting this wrong); no v2 path (HPKE + OHTTP crypto is not tractable to re-implement); Zinqq becomes the slow-follower for any future Payjoin evolution.
- **Rejected**: brainstorm committed to v1+v2; v2 is only feasible via PDK.

### B. Phased v1-then-v2

Ship BIP 78 first, BIP 77 as follow-up.

- **Pros**: faster first cut; smaller review surface.
- **Cons**: PDK bundles both — splitting creates artificial scope. Interim state misses v2-only receivers (notably new mobile wallets). Two code reviews, two deploys, two sets of telemetry baselines.
- **Rejected**: brainstorm, after weighing tradeoffs.

### C. v2-only, skip v1

- **Pros**: simpler code, one transport.
- **Cons**: breaks with BTCPay Server and most live merchant deployments, which are v1.
- **Rejected**: brainstorm.

### D. Server-side Payjoin coordination

Push Payjoin logic entirely into a Zinqq-operated service; client submits a payment request, server runs the exchange, returns a signed tx.

- **Pros**: avoids WASM bundle cost; simpler client.
- **Cons**: violates Zinqq's self-custodial model (server sees sender's PSBT before user signs); operational cost (must run PDK service 24/7); doesn't work for PWA-at-rest.
- **Rejected**: fundamental self-custody violation.

## System-Wide Impact

### Interaction Graph

On-chain send triggered from `Send.tsx:handleOcConfirm`:

```
Send.tsx:handleOcConfirm
  │  • owns useRef<AbortController>; abort on visibilitychange/beforeunload/unmount
  │
  └─ onchain.sendToAddress(address, amount, feeRate, /* transformPsbt */ hook?)
       │   hook provided iff parsed.payjoin is present AND not sendMax
       │
       └─ buildSignBroadcast(buildPsbt, feeRate, transformPsbt?)
             │
             ├─ syncHandleRef.pause()                    (context.tsx:183)
             ├─ build original unsigned PSBT             (BDK TxBuilder)
             │
             ├─ if transformPsbt:
             │    try:
             │      const psbtToSign = await transformPsbt(original, { wallet, feeRate, signal })
             │      │   tryPayjoinSend in payjoin.ts:
             │      │     ├─ 0. kill-switch check (localStorage.zinqq_payjoin_disabled)
             │      │     ├─ 1. pre-flight: sendMax, single UTXO, fee cap ≤ MAX_FEE_SATS
             │      │     │    → if fails, RETURN original unchanged (declined; no telemetry)
             │      │     ├─ 2. loadPdk() via dynamic import (memoised Promise)
             │      │     ├─ 3. PDK SenderBuilder (v1 URL → v1 path; bitcoin:// URL → v2 path)
             │      │     ├─ 4. v1: fetch('/api/payjoin-proxy?_path=HOST/PATH', {POST, body, signal})
             │      │     │      ↓  (proxy uses Edge Runtime; rate-limit via KV)
             │      │     │    receiver's https://btcpay.example/payjoin/xyz
             │      │     │    v2: PDK OHTTP encapsulation
             │      │     │      ↓
             │      │     │    OHTTP relay (ordered fallback across 3 relays)
             │      │     │      ↓
             │      │     │    Directory (payjo.in)
             │      │     ├─ 5. receive proposal PSBT
             │      │     ├─ 6. PDK validates (BIP 78 checklist)
             │      │     ├─ 7. proposal-validator.ts: lookahead-aware is_mine,
             │      │     │    P2WPKH dust (294), change-delta, sighash/derivation
             │      │     │    /script preservation on sender inputs
             │      │     ├─ 8. claim('payjoin') atomic sentinel
             │      │     └─ RETURN proposal PSBT
             │      │
             │      psbtToSign is either proposal (Payjoin) or original (declined)
             │    catch err:
             │      discardStagedChanges(wallet)
             │      psbtToSign = original  // fallback after failed attempt
             │      telemetry bucket: fallback_transient or fallback_validation
             │  else:
             │    psbtToSign = original
             │
             ├─ MAX_FEE_SATS sanity check on psbtToSign  (context.tsx:195)
             ├─ wallet.sign(psbtToSign)
             ├─ const tx = psbtToSign.extract_tx()
             ├─ if transformPsbt succeeded: wallet.apply_unconfirmed_txs([tx])  // balance correctness
             │
             ├─ finalizeAndBroadcast(tx):
             │    ├─ esplora.broadcast(tx)               (via shared EsploraClient; semaphore max=2)
             │    ├─ setState({ balance: … })
             │    ├─ persistChangeset(wallet)
             │    └─ syncHandleRef.syncNow()
             │
             └─ syncHandleRef.resume()                   (finally; single pause/resume pair)
```

**Key invariants:**

- One `pause/resume` pair per call — the fallback path does NOT call back into `buildSignBroadcast`.
- Fee sanity (`MAX_FEE_SATS`) runs once, on whatever PSBT is being signed.
- `discardStagedChanges` fires on every non-success exit from `transformPsbt`.
- `wallet.apply_unconfirmed_txs` only runs for Payjoin-modified txs (BDK didn't build them).

### Error & Failure Propagation

| Layer                   | Error class                                                                                                                                | Handling                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| PDK loader              | Network / dynamic import failure                                                                                                           | `fallback: pdk_load`                                                                                                       |
| PDK sender (build)      | Invalid original PSBT                                                                                                                      | Bubble to user (same as non-Payjoin bad tx)                                                                                |
| Proxy (our server)      | 4xx / 5xx / timeout                                                                                                                        | `fallback: proxy`                                                                                                          |
| Receiver endpoint       | HTTP failure                                                                                                                               | `fallback: network`                                                                                                        |
| PDK sender (validation) | `FeeContributionExceedsMaximum`, `AbsoluteFeeDecreased`, `PayeeTookContributedFee`, `MissingOrShuffledInputs`, `FeeRateBelowMinimum`, etc. | `fallback_validation` telemetry bucket (fine-grained class stays in debug console only — prevents receiver fingerprinting) |
| Post-PDK validation     | Failed is_mine / dust / change-delta / preservation                                                                                        | `fallback_validation` bucket                                                                                               |
| Broadcast               | Esplora error                                                                                                                              | Surfaces to user (same as non-Payjoin)                                                                                     |

**Explicit non-alignment**: we consciously diverge from brainstorm's "silent fallback on any failure" on the `validation` case only — user UX remains silent, but telemetry captures the event because a validating-failed Payjoin likely indicates a hostile or buggy receiver and we need the signal.

### State Lifecycle Risks

- **Mid-flight PSBT**: held in a `Ref` (not state) inside the Payjoin pipeline. Cleared on fallback or success.
- **v2 session**: exists only in memory, scoped to a single `AbortController`. On `beforeunload` the controller aborts; no persistence to `localStorage` / IndexedDB.
- **Original PSBT after fallback**: discarded after broadcast; not retained.
- **Late proposal arrival**: `abortSignal.aborted` alone is insufficient (TOCTOU). We use an atomic single-writer `claim('payjoin' | 'fallback')` sentinel; whichever path claims first wins. Immediately before broadcast, `signal.throwIfAborted()` + `claim(...)` run back-to-back. The receiver's proposal is unsigned on sender inputs and cannot be broadcast by them; the original-PSBT fallback broadcasts identical inputs and wins the race at mempool level even if the proposal leaks out elsewhere.
- **App close during v2 poll**: session lost; original PSBT never signed; **user must re-initiate the payment**. This is explicit and documented.
- **UTXO lock discipline**: BDK's `TxBuilder` stages changes; `finalizeAndBroadcast` commits them via `persistChangeset`. Fallback path does not re-call `TxBuilder` — it reuses the original PSBT built before the Payjoin exchange. No chance of coin-selection drift.

### API Surface Parity

| Interface                                                         | Payjoin-capable?                                                                                           |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `onchain.sendToAddress(address, amount, feeRate, transformPsbt?)` | **Yes** — caller passes `tryPayjoinSend` as the `transformPsbt` hook on `buildSignBroadcast`               |
| `onchain.sendMax(address, feeRate)`                               | **No** — no change output means no fee-contribution slot. Caller never passes `transformPsbt`. Documented. |
| Lightning sends                                                   | N/A — Payjoin is on-chain only                                                                             |
| LNURL sends                                                       | N/A                                                                                                        |
| Future: consolidation / self-send                                 | Payjoin disabled (self-send defeats the purpose)                                                           |

### Integration Test Scenarios

Three-to-six scenarios to run against a real BDK wallet + real PDK + mocked receiver HTTP layer:

1. **Valid v1 roundtrip (happy path)**: regtest BDK wallet funds a send to `bitcoin:...?pj=...`; proxy layer returns a valid proposal (one added input, change reduced by exactly the BIP 78 fee cap). Assert: broadcast tx has 2+ inputs, wallet balance reflects post-broadcast state, `payjoin_succeeded` telemetry fires exactly once.

2. **Receiver returns proposal with one of our inputs**: proposal includes a UTXO from an unused change address. Assert: `wallet.is_mine()` flags it; `fallback: validation`; original PSBT broadcasts successfully; user sees normal success.

3. **Proxy 502 after 2 seconds**: assert within 17s total elapsed time the fallback broadcast fires; PDK WASM was loaded exactly once; no error toast.

4. **sendMax + `pj=` URI**: assert Payjoin path skipped (no PDK load, no proxy hit); normal drain succeeds.

5. **v2 poll + tab hidden**: after 10s of polling, fire `document.visibilitychange` to hidden. Assert: poll aborts; fallback broadcasts; `payjoin_fallback_backgrounded` telemetry.

6. **Late proposal arrives after fallback**: proxy responds at t=17s with a valid proposal while fallback already broadcast at t=15.1s. Assert: proposal dropped silently; no second broadcast attempt; no telemetry duplication; no UI change.

## Brainstorm Refinements

Research surfaced several decisions that refine — not contradict — brainstorm conclusions (see brainstorm: `docs/brainstorms/2026-04-23-payjoin-send-brainstorm.md`).

| Brainstorm decision                                         | Plan refinement                                                                      | Why                                                                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Percentage fee cap on receiver-proposed fee"               | **Weight-based cap: `originalFeeRate × 110 vbytes`**                                 | BIP 78 canonical; BTCPayServer & rust-payjoin reference impls both use weight-based, not %. Spec-correct and matches `SenderBuilder::build_recommended()`.          |
| "Auto-fallback to normal broadcast on any failure (silent)" | **UX remains silent; telemetry distinguishes transient vs validation**               | Silent fallback on validation failures hides hostile-receiver signal. User still never sees a difference; we just don't silently discard the signal.                |
| "Session-only v2 state"                                     | Confirmed + explicit "app close during v2 poll = user must re-initiate"              | Spec-flow surfaced the implied consequence. Worth stating outright.                                                                                                 |
| "v1 + v2 single shipment"                                   | Confirmed + v1 timeout 15s, v2 foreground poll 30s                                   | v2 OHTTP round-trip takes 2-4s per poll; 15s is too tight for receivers with human-in-the-loop. Research confirms no spec standard; 30s is a pragmatic PWA ceiling. |
| "`pjos=0` out of scope"                                     | Confirmed + **explicitly documented as intentional privacy regression for receiver** | Not hand-waved. Recorded as a known divergence from BIP 78 intent.                                                                                                  |

## Acceptance Criteria

### Functional Requirements

- [x] `parseBip321()` extracts `pj` and `pjos` parameters (case-insensitive keys)
- [x] ~~Non-`https:` `pj=` URLs are silently dropped~~ — **revised**: raw capture at parser layer; scheme validation deferred to PDK so BIP 77 v2 `bitcoin:`/`payjoin:` URLs are not dropped. Empty/length-bounded rejection only.
- [x] `ParsedPaymentInput`'s `onchain` variant exposes optional `payjoin` field
- [x] Tests cover: `pj=` attached, uppercase `PJ=`, v2 `bitcoin://` accepted, empty rejected, length-bounded rejected, `pjos=0` marks `strict: true`, `pj=` + `lightning=` together yields Lightning branch (payjoin not attached)
- [ ] Payjoin path triggered iff: `payjoin` attached AND on-chain branch AND not `sendMax` AND wallet UTXO count > 1
- [ ] PDK WASM bundle is code-split; main bundle size delta ≤ 2 KB (CI gate)
- [ ] PDK loads lazily (dynamic `import()`) only after the original PSBT builds successfully
- [ ] v1: POST through `/api/payjoin-proxy` with 15s timeout; `minfeerate` set to `MIN_FEE_RATE_SAT_VB`; `additionalfeeoutputindex` set to change output index; `maxadditionalfeecontribution` = `originalFeeRate × 110`
- [ ] v2: OHTTP via directory (payjo.in default) with 30s foreground poll; poll aborts on fallback / tab hidden / navigation
- [ ] Proposal validation: PDK's BIP 78 checklist + `wallet.is_mine()` on every receiver-added input + dust threshold per script type + change-delta ≤ `maxadditionalfeecontribution`
- [ ] Any failure in Payjoin path falls back to signing and broadcasting the original PSBT
- [ ] Fallback is indistinguishable from a normal send in the user UI
- [ ] Telemetry events: `payjoin_attempted`, `payjoin_succeeded`, `payjoin_fallback_{network|timeout|validation|pdk_load|proxy|backgrounded|unknown}`. No PII, no txids, no amounts, no addresses.
- [ ] `localStorage.zinqq_payjoin_debug=1` exposes fallback reasons via `console.info`; absent/false → no console output
- [ ] Late proposals (arriving after fallback broadcast) are silently dropped; no double-broadcast
- [x] Proxy allowlist validated: non-https rejected, non-allowed content-type rejected, body > 100 KB rejected, no method other than POST accepted (22 unit tests in `api/payjoin-proxy.test.ts`; durable KV rate-limit deferred to follow-up PR before Phase 3 consumes the proxy)

### Non-Functional Requirements

- [ ] PDK WASM bundle budget: ≤ 1.2 MB gzipped (CI gate; fail PR if exceeded)
- [ ] Time-to-interactive on `Send` page unchanged (measured via existing TTI probe if present, else Lighthouse)
- [ ] PDK WASM served with `Cache-Control: public, max-age=31536000, immutable` for efficient PWA caching after first load
- [ ] Sender IP never exposed to receiver: v1 always through our serverless proxy; v2 always through OHTTP relay (PDK handles)
- [ ] Proxy does not log request bodies; request/response never written to persistent storage
- [ ] `X-Forwarded-For` stripped on proxy's upstream request
- [ ] Service Worker does not cache `/api/payjoin-proxy` responses (default Workbox behavior for POST; verified)
- [ ] All Payjoin HTTP requests use `cache: 'no-store'`
- [ ] vendored PDK WASM has SHA-256 in `pdk-wasm.manifest.json`; CI verifies a fresh build matches the manifest

### Quality Gates

- [ ] Unit test coverage for `parseBip321` Payjoin branches: 100%
- [ ] Unit tests for `proposal-validator.ts`: each rejection path exercised
- [ ] Integration tests from _Integration Test Scenarios_ above pass against a local `payjoin-cli` receiver (regtest via nigiri)
- [ ] Manual mainnet verification against a live BTCPay Server instance documented in PR description
- [ ] Documentation: README update describing Payjoin support; developer doc in `docs/solutions/` for vendoring + update cadence

## Success Metrics

- **Primary**: `payjoin_succeeded / payjoin_attempted` ≥ 70% against cooperating receivers within 30 days of ship (measures: is our implementation competent?).
- **Secondary**: `payjoin_fallback_validation` rate < 1% of attempts (measures: are we correctly validating, or are we hitting false-rejects?).
- **Bundle impact**: main chunk unchanged ± 2 KB; PDK chunk first-byte-to-interactive on send < 500ms on warm cache, < 2s cold.
- **No regression**: non-Payjoin send success rate unchanged vs 30-day baseline.

## Dependencies & Prerequisites

- **Upstream**: `payjoin` crate v0.25.0 + `payjoin-ffi` v0.24.0 (both exist as of April 2026). JavaScript bindings built from source until npm publish.
- **Infra**: Vercel serverless function capacity (one new endpoint); no new external services beyond `payjo.in` directory and three public OHTTP relays (which are external dependencies we don't control).
- **Blocking prerequisites**: none. All integration points in the codebase exist today.
- **Soft dependencies**: existing `api/lnurl-proxy.ts` pattern serves as the template; `src/onchain/context.tsx:buildSignBroadcast` is the pipeline we extend.

## Risk Analysis & Mitigation

| Risk                                                                                 | Likelihood                       | Impact | Mitigation                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------ | -------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PDK unreleased library has breaking changes in next 6 months                         | High                             | Medium | Pin to commit SHA; document update cadence; versioned manifest.                                                                                                                                            |
| Vendored WASM bundle bloats main chunk                                               | Low                              | High   | CI bundle-size check on main chunk; code-split enforced by dynamic import.                                                                                                                                 |
| Public OHTTP relays go offline or rate-limit us                                      | Medium                           | Medium | Ordered fallback across three relays; if all fail → v2 fallback to fallback.                                                                                                                               |
| Malicious receiver exploits edge case in PDK validation                              | Low                              | High   | `proposal-validator.ts` defense-in-depth; lookahead-aware `wallet.is_mine()` check; change-delta cap; sighash/derivation/script preservation asserts; telemetry surfaces `fallback_validation` for review. |
| Receiver CORS breakage on v1                                                         | High (spec compliance is spotty) | Low    | Always proxy through `/api/payjoin-proxy`; never direct fetch.                                                                                                                                             |
| Proxy abused as open relay                                                           | Medium                           | Medium | Host + content-type + body-size allowlists; rate limit per IP.                                                                                                                                             |
| User sees occasional ~3s latency bump (v2 fallback) with no explanation              | Medium                           | Low    | `localStorage` debug flag for power users; silent UX for everyone else. Accepted tradeoff from brainstorm.                                                                                                 |
| `pj=` endpoint injects `Set-Cookie` or other unwanted side effects through the proxy | Low                              | Low    | Proxy strips all set-cookie headers; only `content-type` forwarded.                                                                                                                                        |
| BDK staged-change drift between estimate build and PSBT build                        | Medium                           | Medium | Covered by existing `discardStagedChanges` pattern at `src/onchain/context.tsx:165`.                                                                                                                       |
| Supply-chain attack via vendored PDK WASM                                            | Low                              | High   | SHA-256 manifest checked into repo; CI verifies fresh build matches.                                                                                                                                       |

## Resource Requirements

- **Engineer-days**: ~7 (see phase breakdown)
- **Infra**: one new Vercel serverless function (no cost change)
- **Testing**: local `payjoin-cli` + nigiri for regtest integration; one-time manual mainnet verification via live BTCPay Server

## Future Considerations

- **Receive-side Payjoin**: large next step; likely to be driven by LSPS5 async payment timelines (see memory `project_offline_receive_strategy`). Not in this plan.
- **Multi-party Payjoin (coinjoin-adjacent)**: out of scope; different threat model.
- **Payjoin-over-Lightning variants**: out of scope; likely to be standardized on BIP 77 v2 relays anyway.
- **PDK npm publish**: when rust-payjoin publishes `payjoin-ffi/javascript` to npm, migrate from vendored submodule to a regular dependency. Should be straightforward given our manifest approach.

## Post-Deploy Monitoring & Validation

- **What to monitor**
  - Telemetry events: `payjoin_attempted`, `payjoin_succeeded`, `payjoin_fallback_{reason}`
  - Bundle analyzer diff: main chunk unchanged; PDK chunk under budget
  - Vercel function logs for `api/payjoin-proxy`: request rate, error rate, latency p50/p95
- **Validation checks**
  - `count(payjoin_succeeded) / count(payjoin_attempted) ≥ 0.7` over the first 30 days against cooperating receivers
  - `count(payjoin_fallback_validation) / count(payjoin_attempted) < 0.01`
  - p95 latency on `/api/payjoin-proxy` < 3s
- **Expected healthy behavior**: sends complete successfully whether or not Payjoin succeeds; no error toasts introduced; no user reports of send failures on previously-working BIP 321 URIs
- **Failure signal / rollback trigger**
  - Any non-zero rate of unexpected send failures (i.e., txs that would have succeeded before this PR now fail)
  - `payjoin_fallback_validation` spike > 5% — suggests a hostile-receiver campaign or a PDK validation bug
  - Bundle size CI gate fails on a subsequent PR
  - Immediate rollback via Vercel: revert PR; feature has no persistent state, zero migration, safe to revert
- **Validation window & owner**: 7 days post-ship active monitoring; Conor owns the dashboard and response

## Documentation Plan

- `README.md`: one-line mention of Payjoin support under features
- `docs/solutions/integration-issues/payjoin-pdk-wasm-vendoring.md`: how we vendor, how to update, how to verify the manifest
- `docs/solutions/integration-issues/payjoin-send-proxy-pattern.md`: the serverless proxy design (mirrors `lnurl-proxy` pattern)
- Inline JSDoc on `tryPayjoinSend`, `validateProposal`, `loadPdk`
- Developer note: `pjos=0` intentionally ignored — link to this plan

## Deepening Research Insights

Synthesized from 9 parallel reviewers/researchers. Findings below apply across sections; cross-reference with the section they modify.

### Security (from security-sentinel)

**CRITICAL — proxy SSRF controls.** The initial `ALLOWED_HOSTS` comment allowed "any v1 host, validate scheme only." This is effectively an open relay. Required controls on `api/payjoin-proxy.ts`:

- Reject private/loopback/link-local ranges: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`, `0.0.0.0/8`, `100.64.0.0/10`. Validate **after DNS resolution**, not from URL string alone (cloud metadata at `169.254.169.254` is reachable via `example.com`-redirect otherwise).
- Reject IPv4-mapped IPv6 (`::ffff:127.0.0.1`) and IPv4-compatible forms.
- Reject URLs with `userinfo` (`user@host`).
- Reject non-default ports except 443.
- `redirect: 'manual'` — upstream 302 must not bypass validation.
- **DNS rebinding**: resolve once, pin IP, connect by IP with `Host`/SNI set to hostname. On Vercel this is non-trivial; at minimum document the residual risk.
- Max URL length ≤ 2048; reject CR/LF in `_url`/`_path` (header injection).
- **Header handling**: allowlist, not denylist. Strip inbound `Host`, `Cookie`, `Authorization`, `X-*`, `Origin`, `Referer`, `User-Agent`, `Accept-Language`. Send fixed `User-Agent: payjoin-client/1.0`. Strip `Set-Cookie` on responses.

**CRITICAL — durable rate limiting.** In-memory per-lambda counters are useless on Vercel serverless. Must use Vercel KV, Upstash, or Edge Config. Gate this as a ship requirement, not a nice-to-have.

**HIGH — direct-fetch prevention.** Assert no code path reaches `pj=` endpoints directly. Add an eslint `no-restricted-syntax` rule forbidding `fetch(` under `src/onchain/payjoin/`. PDK may support a custom `http_client`; pass ours, not its default.

**HIGH — additional PSBT validation** (beyond PDK's BIP 78 checklist):

- Sighash flags preserved on every sender input.
- Non-witness UTXO stripped on segwit inputs in proposal (CVE-2020-14199-class).
- BIP32 derivation paths byte-equal to original on sender inputs.
- Witness/redeem script fields byte-equal on sender inputs.
- Taproot: `tap_key_sig`, `tap_script_sig`, `tap_merkle_root`, `tap_leaf_script` all untouched on sender inputs.
- Sender change output scriptPubKey byte-equal (only value may decrease by ≤ `maxAdditionalFeeContribution`).
- Strip global xpub / proprietary fields before signing.

**HIGH — telemetry error-class bucketing** prevents receiver fingerprinting: aggregate `FeeContributionExceedsMaximum`, `PayeeTookContributedFee`, `MissingOrShuffledInputs`, etc. into a single `fallback_validation` at the telemetry layer. Keep the fine-grained class in the `localStorage.zinqq_payjoin_debug` console channel only.

**HIGH — supply chain**: SHA-256 manifest alone proves "you built it this way once." Stronger: GitHub Actions `attest-build-provenance` (SLSA 3), two-person review on submodule bumps, `CODEOWNERS` routing submodule changes to a security reviewer. Dependabot does NOT cover this — manual review of `payjoin-ffi` source per bump is mandatory.

**MEDIUM — fee griefing ceiling**: BIP 78 formula `originalFeeRate × 110` lets a colluding receiver extract significant sats from heavy users over many sends. Mitigation: cap at `min(originalFeeRate × 110, 0.01 × amount)` and enforce absolute per-send ceiling of 10,000 sats.

**MEDIUM — `connect-src 'https:'` is too broad**. If v1 always goes through `/api/payjoin-proxy` and v2 through a small OHTTP relay allowlist, `connect-src 'self' https://payjo.in https://pj.benalleng.com https://pj.bobspacebkk.com https://ohttp.achow101.com` is finite. Prefer explicit allowlist.

### Data Integrity (from data-integrity-guardian)

Zinqq is BIP84 P2WPKH-only (verified in `src/wallet/keys.ts:67-82`). This narrows several concerns:

- **Dust simplification**: delete P2PKH branch; fix P2TR number from 302 to 330; Zinqq's change is always P2WPKH, so check against 294 sats only.
- **`is_mine` lookahead gap**: BDK's `is_mine` checks against a lookahead-limited derivation cache (default 25 beyond last-revealed). An attacker-proposed UTXO at `last_revealed + 26` returns false even though the script is ours. **Mitigation**: before validation, call `wallet.reveal_addresses_to(external, current + 1000)` and same for internal keychain, check `is_mine`, then `discardStagedChanges` to undo the reveal. Add to `proposal-validator.ts` as check (d).
- **Don't sign the original PSBT before the branch decision.** Signing stages signer metadata in BDK; if Payjoin succeeds we want proposal staging, not original staging.
- **`discardStagedChanges` on every non-success exit** — mirror the `context.tsx:196` pattern. If the proposal trips the `MAX_FEE_SATS` sanity check, staged address advancement from the original build pollutes the keychain cursor.
- **Pre-flight assertion**: `originalFee + originalFeeRate × 110 ≤ MAX_FEE_SATS`. If not, skip Payjoin rather than produce a proposal that will fail fee sanity downstream.
- **`wallet.apply_unconfirmed_txs([proposalTx])` required** before reading balance on Payjoin success. BDK didn't build the proposal tx; without this call, `wallet.balance` under-counts until the next sync, leaving a window where the user could attempt another send using the already-spent UTXOs.
- **Changeset persistence on broadcast failure**: current `buildSignBroadcast` has a latent gap at lines 229-233 (sign stages then rethrow leaves staging). Payjoin path must `discardStagedChanges` in its catch branch before rethrow.

### Race Conditions & Timing (from julik-frontend-races-reviewer)

**The `abortSignal.aborted` check is TOCTOU**. Between check and `wallet.sign`, fallback broadcast may complete. Replace with an atomic single-writer claim:

```typescript
const outcome = { kind: 'pending' as 'pending' | 'payjoin' | 'fallback' }
const claim = (next: 'payjoin' | 'fallback') => {
  if (outcome.kind !== 'pending') throw new AbortError('already ' + outcome.kind)
  outcome.kind = next
}
// immediately before broadcast: signal.throwIfAborted(); claim('payjoin' | 'fallback'); broadcast
```

**Single-aborter pattern** for visibility + timeout + user-cancel + unmount — all feed one `AbortController`, first reason wins via `signal.reason`. Use `AbortSignal.any([userSig, timeoutSig, visibilitySig, unmountSig])` — Safari < 17.4 needs a 12-line polyfill; do not pull `abort-controller-x`.

**`uniffiInitAsync()` idempotency is not guaranteed** across uniffi-rs generations. Memoise the init Promise _inside_ the same `loadPdk` Promise, not separately.

**No nested `buildSignBroadcast` on fallback.** The plan's `finalizeAndBroadcast(tx)` extraction is correct and MUST be the only broadcast path — calling the full `buildSignBroadcast` from the Payjoin path's fallback branch double-pauses the sync handle. Make this a hard invariant.

**v2 poll cadence**: recursive self-scheduling `setTimeout` with exponential backoff 1s → 5s, abort-aware `sleep`. No `setInterval`. Explicit in the plan:

```typescript
let delay = 1000,
  cap = 5000
while (!signal.aborted) {
  const r = await fetchDirectory(signal)
  if (r.proposal) return r.proposal
  await sleep(delay, signal)
  delay = Math.min(delay * 1.5, cap)
}
signal.throwIfAborted()
```

**PDK callback reentrancy**: keep PDK log callbacks pure — write to a local array, flush after the call returns. Never touch React state or outcome sentinel from inside a PDK callback.

**Late-proposal handling**: add a 7th integration test — "proposal returns at t=15.05s while fallback sign is mid-flight at t=15.00s." Current scenario 6 only covers post-broadcast.

### Architecture (from architecture-strategist)

**HIGH — adopt `transformPsbt` hook, retire `buildSignBroadcastPayjoin`**. Rather than forking:

```typescript
buildSignBroadcast(
  buildPsbt: (fr: FeeRate) => Psbt,
  feeRateSatVb?: bigint,
  transformPsbt?: (unsigned: Psbt, ctx: { wallet, feeRate }) => Promise<Psbt>
)
```

Payjoin passes `transformPsbt`; normal send omits it. `MAX_FEE_SATS` sanity check runs automatically on the transformed PSBT. Fallback is `transformPsbt` returning the original unsigned PSBT on throw. Zero duplication.

**HIGH — runtime feature flag / kill switch.** `localStorage.zinqq_payjoin_disabled=1` (checked _before_ the dynamic import). No PDK load when disabled. Incident-response tool; cached service workers delay a code revert by hours, a flag is immediate.

**MEDIUM — hoist constants to `src/onchain/config.ts`.** `MIN_FEE_RATE_SAT_VB` and `MAX_FEE_SATS` currently live privately in `context.tsx:31`. Dependency direction should point from provider to children, not reverse. `config.ts` already exports `ONCHAIN_CONFIG` — natural home.

**MEDIUM — telemetry via `captureError`.** No analytics layer exists in Zinqq. `captureError('info', 'Payjoin', 'payjoin_succeeded', detail)` uses the existing channel (`src/storage/error-log.ts`). Don't invent a parallel pattern for one feature.

**MEDIUM — lazy-WASM primitive.** `src/wasm/loader.ts` is an unused placeholder. Put the memoised-Promise helper there as `createLazyWasmModule<T>(loader)`; PDK becomes its first caller; future WASM features reuse it.

**LOW — defer proxy unification.** `lnurl-proxy.ts` (GET, different threat model) and the proposed `payjoin-proxy.ts` (POST, SSRF-sensitive) shouldn't merge until N=3. Keep separate.

**LOW — merge Phases 1 + 2.** 0.5d URI parser produces dead code; combining with proxy scaffolding gives one reviewable "scaffolding" PR.

**LOW — integration test mocking strategy.** Scenario 1 (happy-path v1) genuinely needs real PDK. Scenarios 2-7 can mock PDK's `Sender` trait with fixture PSBTs — faster, deterministic, and they test Zinqq's validation/fallback, which is what regresses.

### TypeScript Quality (from kieran-typescript-reviewer)

**Required before implementation**:

1. `FallbackReason` as const-object with derived type (not bare string literal union) — gives a runtime-iterable source of truth for telemetry event names. Also catches current plan drift (acceptance lists `backgrounded`, components section omits it):

```typescript
export const FALLBACK_REASONS = {
  network: 'network',
  timeout: 'timeout',
  validation: 'validation',
  pdkLoad: 'pdk_load',
  proxy: 'proxy',
  pdkError: 'pdk_error',
  backgrounded: 'backgrounded',
  unknown: 'unknown',
} as const satisfies Record<string, string>
export type FallbackReason = (typeof FALLBACK_REASONS)[keyof typeof FALLBACK_REASONS]
```

2. Narrow `PayjoinSenderApi` interface in `pdk-loader.ts` — expose only what Zinqq uses (`SenderBuilder`, `parseUri`, selected error classes). Prevents ambient PDK types from leaking; makes `vi.mock('./pdk-loader', () => ({ loadPdk: vi.fn() }))` a one-liner.

3. Proxy handler signature: `export async function POST(request: Request): Promise<Response>` — match `api/lnurl-proxy.ts`. Not the Express-style `(req, res)` in the initial plan snippet.

**Clarifying addition**: document in Components §2 that `outcome: 'fallback'` is a _successful_ return, not an error — must NOT route through `mapSendError`. Only genuinely unrecoverable states (invalid original PSBT) `throw` out of `tryPayjoinSend`.

**AbortSignal ownership**: `Send.tsx:handleOcConfirm` owns a `controllerRef = useRef<AbortController | null>(null)`; `beforeunload` + `visibilitychange` listeners abort it; `tryPayjoinSend` internally composes via `AbortSignal.any([signal, AbortSignal.timeout(15_000)])` (v1) or `timeout(45_000)` (v2). Existing precedent: `src/ldk/sync/esplora-client.ts:100`.

### Performance (from performance-oracle)

**Bundle budget realistic with aggressive gating**: compile `payjoin-ffi --no-default-features --features send,v1,v2` (drop `receive`, `danger-local-https`, directory, relay features). Add `wasm-opt -Oz -g0`. Realistic target: 900 KB – 1.1 MB gzip. Near-miss → code-split v1 vs v2 (v1 URIs typically don't need HPKE), saves ~300 KB for v1-only sends.

**Cold start optimizations**:

- Use `WebAssembly.compileStreaming(fetch(...))`, not `new WebAssembly.Module(await (await fetch()).arrayBuffer())` — halves compile time.
- Content-hashed WASM filename (Vite default) so bumping vendored SHA yields a new URL; otherwise SW serves stale WASM after update.
- `Cache-Control: public, max-age=31536000, immutable` — already planned.

**Speculative parallel load**: fire `loadPdk()` as soon as user taps "Send" on a `pj=` URI, parallel with `buildPsbt()`. ~15% faster on cold Payjoin sends; abort cost trivial.

**Edge Runtime for proxy**: `export const config = { runtime: 'edge' }` — drops proxy coldstart from 200-800ms to 10-50ms. Compounds across v2 polls.

**OHTTP latency**: p50 ≈ 500-900ms per poll; p95 ≈ 1.5-3s. **Bump v2 foreground poll from 30s to 45s** (plan updated). BTCPay/Bull observed v2 exchanges taking 10-25s.

**Memory**: after send, call `handle.free()` on PDK sender in `finally`. Don't unload WASM module (browsers don't reclaim instantiated module memory anyway; user may send again).

**Retry policy**: no retry on v1 (15s budget too tight); one proxy-level retry on 502/503/504 with 500ms backoff for v2 relay hiccups (~2-5% lift). Never retry on validation errors.

**Esplora broadcast MUST go through shared `EsploraClient`** (not raw `fetch`), or bypasses the max-2 semaphore. Acceptance criterion.

### Pattern Alignment (from pattern-recognition-specialist)

Codebase-specific conventions to honor:

| Convention                                   | Required change                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Test files are sibling `*.test.ts`           | Drop `__tests__/` subdir                                                                                                                   |
| File naming: noun-role (`bolt11-encoder.ts`) | Rename `validate.ts` → `proposal-validator.ts`                                                                                             |
| Proxy handler: Web `Request`/`Response`      | Align `payjoin-proxy.ts` with `esplora-proxy.ts` pattern                                                                                   |
| Proxy param: `_path`                         | Use `_path` not `_url`                                                                                                                     |
| Constants: `src/onchain/config.ts`           | Hoist `MIN_FEE_RATE_SAT_VB`, `MAX_FEE_SATS`                                                                                                |
| Error log: `captureError`                    | Wire Payjoin events through it, not a new module                                                                                           |
| `ParsedPaymentInput` extension               | Optional sub-field on `onchain` variant is the right call; diverge intentionally from "new variant" precedent (avoids call-site explosion) |
| WASM: dynamic vs eager                       | PDK is justified divergence — explicitly note in plan                                                                                      |

### Simplicity (from code-simplicity-reviewer)

Trim over-engineering:

- Collapse 5 modules into fewer: one `payjoin.ts` (sender logic + PDK load) + `proposal-validator.ts`. Inline telemetry calls at fallback sites rather than a wrapper. Split when a second caller exists.
- Drop `localStorage.zinqq_payjoin_debug` as speculative power-user tooling (but **keep** `zinqq_payjoin_disabled` — it's an incident response lever with a concrete use case).
- 7 fallback reasons → 3 for telemetry (`succeeded`, `fallback_transient`, `fallback_validation`); fine-grained reasons remain in debug console.
- Drop `application/octet-stream` content-type from allowlist (spec is `text/plain` for v1, `message/ohttp-req` for v2; accommodate stragglers when one appears).
- Drop the "is_mine re-assert PDK's witness invariant" defense-in-depth bullet — PDK already enforces; this is paranoia.
- Drop "skip Payjoin if user sat on review screen > 60s" (fee-drift guard) — speculative; normal send has no such guard.
- Scenarios 4 (sendMax skip) becomes a unit test, not integration. Ship with 3 integration scenarios (happy-path, validation rejection, proxy 502); v2-backgrounded and late-proposal added post-ship once real traffic shows relevance.
- Phase count: 6 → 4. Merge Phase 1 into the wiring phase; merge Phase 6 polish into Phase 5 v2.

### Supply Chain & Vendoring (from best-practices-researcher)

**First, verify:** `npm view payjoin versions dist-tags` before Phase 3. Research found credible signal that `payjoin` is published on npm; if the published artifact covers the WASM target, skip vendoring entirely.

**If vendoring needed:**

- `rustwasm` working group archived July 2025. Use `wasm-bindgen-cli` + `cargo build --target wasm32-unknown-unknown` + `wasm-opt` directly. `wasm-pack` is no longer preferred.
- Reproducibility requires: `rust-toolchain.toml` pin, `wasm-bindgen-cli` version match with `wasm-bindgen` crate, `wasm-opt` version pin, `RUSTFLAGS` scrubbed, `SOURCE_DATE_EPOCH` set, `--remap-path-prefix` for filesystem paths, `cargo --locked --frozen` with committed `Cargo.lock`.
- **Attestation**: use GitHub Actions `actions/attest-build-provenance` (works for any artifact, produces Sigstore bundle). `npm provenance` doesn't help since we wouldn't be publishing to npm.
- Cadence: rebuild on upstream release tags + weekly scheduled CI job bumps submodule to HEAD on a PR for review. Never auto-merge.
- CI gate: per-PR hash-manifest check (sub-second); full rebuild weekly to detect drift.

### OHTTP / BIP 77 Specifics (from best-practices-researcher)

- `message/ohttp-req` / `message/ohttp-res` are non-simple content types → every `fetch()` triggers CORS preflight. Relay must return `Access-Control-Allow-Headers: content-type`, `Access-Control-Allow-Methods: POST`, generous `Access-Control-Max-Age`.
- CORS posture of `pj.benalleng.com`, `pj.bobspacebkk.com`, `ohttp.achow101.com` **unverified**. Probe with `OPTIONS` preflight from `zinqq.app` origin before committing to browser-direct. Default assumption: proxy all v2 traffic through `/api/payjoin-proxy` too.
- Browsers don't support chunked OHTTP (`draft-ohai-chunked-ohttp`); ensure relay returns single-shot `application/ohttp-res`.
- HPKE key fetch from `payjo.in/ohttp-keys`: treat as long-lived but refresh on 422 and at 24h intervals.
- No keep-alive control in browser fetch — each poll is a fresh connection. Fine for Payjoin's infrequent polling.

### Verification Summary

Claims in the initial plan cross-checked against the codebase:

| Claim                                          | Status    | Correction                                                                       |
| ---------------------------------------------- | --------- | -------------------------------------------------------------------------------- |
| Tests live as sibling `*.test.ts`              | CONFIRMED | Plan had `__tests__/` — fixed                                                    |
| `MIN_FEE_RATE_SAT_VB` at context.tsx:186-190   | REFUTED   | Actually line 31, not exported                                                   |
| Existing telemetry/analytics layer             | REFUTED   | None exists — route through `captureError`                                       |
| LDK/BDK WASM eager-loaded                      | CONFIRMED | PDK dynamic import is justified divergence                                       |
| `src/onchain/` flat w/ subdirs                 | CONFIRMED | Only `storage/`; `payjoin/` consistent                                           |
| `vercel.json` has no CSP                       | CONFIRMED | Plan's CSP addition is net-new                                                   |
| `api/lnurl-proxy.ts` is GET-only, uses `_path` | CONFIRMED | Plan had Express shape + `_url` — both corrected                                 |
| `discardStagedChanges` at context.tsx:55-57    | CONFIRMED | Used at lines 165, 196                                                           |
| `ParsedPaymentInput` extension precedent       | REFUTED   | Type stable ~6 months; adding optional field is precedent-breaking but justified |
| Esplora semaphore                              | CONFIRMED | `src/ldk/sync/esplora-client.ts:19-40`, max=2                                    |
| `mapSendError` taxonomy                        | CONFIRMED | context.tsx:59-76, 4-class taxonomy                                              |
| AbortController in send flow                   | REFUTED   | Plan introduces it for the first time in send flow                               |

## Sources & References

### Origin

- **Brainstorm**: [`docs/brainstorms/2026-04-23-payjoin-send-brainstorm.md`](../brainstorms/2026-04-23-payjoin-send-brainstorm.md) — carries forward sender-only scope, v1+v2 single shipment, silent UX, auto-fallback, session-only state, fee cap (shape refined to weight-based per research).

### Internal References

- URI parser: `src/ldk/payment-input.ts:195-249` (`parseBip321`), `src/ldk/payment-input.ts:26-49` (`ParsedPaymentInput` union)
- Send pipeline: `src/onchain/context.tsx:177-236` (`buildSignBroadcast`), `src/onchain/context.tsx:31` (`MIN_FEE_RATE_SAT_VB` — private module constant, to be hoisted into `src/onchain/config.ts`), `src/onchain/context.tsx:195-198` (`MAX_FEE_SATS` fee sanity), `src/onchain/context.tsx:55-57` (`discardStagedChanges`), `src/onchain/context.tsx:59-76` (`mapSendError` taxonomy)
- Review screen: `src/pages/Send.tsx:869-907`
- Existing proxy: `api/lnurl-proxy.ts`, dev proxy at `vite.config.ts:14-50`
- PWA config: `vite.config.ts:85-103`
- Tests: `src/ldk/payment-input.test.ts`, `src/onchain/bip321.test.ts`
- Institutional learnings:
  - `docs/solutions/integration-issues/bip321-unified-uri-bolt11-invoice-generation.md` — URI param handling
  - `docs/solutions/integration-issues/bdk-wasm-txbuilder-consumes-self.md` — TxBuilder chaining
  - `docs/solutions/integration-issues/bdk-wasm-onchain-send-patterns.md` — build/sign/broadcast patterns, sync pause
  - `docs/solutions/integration-issues/pwa-workbox-vercel-csp-integration.md` — CSP `connect-src` extension
  - `docs/solutions/integration-issues/vss-cors-bypass-vite-proxy.md` — dev + prod proxy pattern
  - `docs/solutions/integration-issues/esplora-request-batching-dedup-caching.md` — request concurrency
  - `docs/solutions/design-patterns/react-send-flow-amount-first-state-machine.md` — send state machine
- Relevant memories: `project_offline_receive_strategy.md` (informs future receive-Payjoin direction), `feedback_no_currency_picker.md` (silent UX aligns with "fully-specified URI" principle), `project_signet_only.md` (mainnet only — no testnet branches in code)

### External References

- [BIP 78 — Payjoin v1 spec](https://github.com/bitcoin/bips/blob/master/bip-0078.mediawiki)
- [BIP 77 — Async Payjoin v2 spec](https://mirror.b10c.me/bitcoin-bips/1483/)
- [rust-payjoin repo](https://github.com/payjoin/rust-payjoin) — source of `payjoin`, `payjoin-ffi`, `payjoin-cli`, `payjoin-directory`
- [Payjoin Dev Kit docs](https://payjoin.org/docs/) — v1 and v2 tutorials
- [BTCPayServer.BIP78 (C# reference sender)](https://github.com/btcpayserver/BTCPayServer.BIP78/blob/master/BIP78.Sender/PayjoinClient.cs) — validation logic reference
- [Sparrow #857 — missing `minfeerate` bug](https://github.com/sparrowwallet/sparrow/issues/857)
- [BTCPay #4689 — missing `minfeerate` bug](https://github.com/btcpayserver/btcpayserver/issues/4689)
- [Bull Bitcoin v0.4.0 (first mobile BIP 77)](https://www.bullbitcoin.com/blog/bull-bitcoin-wallet-payjoin), [nobsbitcoin writeup](https://www.nobsbitcoin.com/bull-bitcoin-wallet-v0-4-0/)
- [Ghesmati et al. (2022) — UIH and Payjoin](https://eprint.iacr.org/2022/589)
- [Payjoin Dev Kit testing guide (regtest + nigiri)](https://payjoindevkit.org/send-receive-test-payjoins/)
- [Btrust Q1 2026 grant — BDK↔PDK integration](https://blog.btrust.tech/q1-2026-btrust-developer-grant-announcement/)
- [RFC 9458 — Oblivious HTTP](https://www.rfc-editor.org/rfc/rfc9458)

### Default Infrastructure

- v2 directory: `https://payjo.in`
- OHTTP relays: `https://pj.benalleng.com`, `https://pj.bobspacebkk.com`, `https://ohttp.achow101.com`
