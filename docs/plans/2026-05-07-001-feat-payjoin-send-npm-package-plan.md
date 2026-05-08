---
title: Payjoin Send (BIP 77 v2) via official `payjoin` npm package
type: feat
status: active
date: 2026-05-07
origin: docs/brainstorms/2026-05-07-payjoin-send-npm-package-brainstorm.md
supersedes: docs/plans/2026-04-23-001-feat-payjoin-send-support-plan.md
---

# Payjoin Send (BIP 77 v2) via official `payjoin` npm package

## Enhancement Summary

**Deepened on:** 2026-05-08 (one day after initial plan)

**Agents engaged:** security-sentinel, architecture-strategist, kieran-typescript-reviewer, code-simplicity-reviewer, performance-oracle, julik-frontend-races-reviewer, pattern-recognition-specialist, plus targeted Explore agents for Vite `?url` WASM emission and PWA timer reliability.

### Critical corrections applied (inline fixes throughout)

1. **Telemetry channel is wrong shape** — `captureError('warning', 'Payjoin', 'success', ...)` mislabels success as warning. Two reviewers flagged independently. Fix: introduce `captureEvent(source, kind, fields)` sibling in `src/storage/error-log.ts`; route success/fallback through it. Keep `captureError` for actual exceptions only.
2. **`PayjoinOutcome` shape** — switch to `{ status: 'success' | 'fallback' }` discriminant matching existing `PaymentResult` (`src/ldk/ldk-context.ts:20`). Drops the `fallbackReason: null` overload.
3. **Claim sentinel scoping** — must be **per-pending-txid** (keyed by `tx.compute_txid().toString()`), persisted in IDB. Per-call sentinel does nothing useful; module-scope sentinel locks out retries permanently after the first failure.
4. **`loadPdk()` failure-reset** — mirror `src/ldk/init.ts:156-167`: on PDK init failure, null the cached promise so retries don't return the rejected promise.
5. **`buildSignBroadcast` signature** — convert to options object now rather than ship 4-positional-param API. Discriminated `TransformResult = { kind: 'replaced' | 'unchanged'; psbt }` so `apply_unconfirmed_txs` doesn't peek inside the abstraction by checking presence of the `transformPsbt` arg.
6. **Cross-tab double-broadcast** — `navigator.locks.request('zinqq:broadcast:' + txid, ...)` around the broadcast tail. ~5 LOC. Safari 15.4+, in target.
7. **`visibilitychange` flicker** — 1500ms debounce to prevent iOS app-switcher gestures from killing in-flight Payjoin sessions.
8. **Mounted-ref guard** — `mountedRef.current` check before `setSendStep(...)` post-await; otherwise unmount-during-Payjoin loses state silently.
9. **Receiver UTXO probe — adaptive budget + caching + chunked yielding** — static 10,000 budget is exposed if `last_revealed_index` exceeds 10,000 between sends. Switch to `max(10_000, last_revealed_external + 5_000)` per keychain, recomputed at validation time. Cache the resulting Set keyed by `(descriptor, last_revealed_external, last_revealed_internal)` for reuse across sends within a session. Yield to the event loop every 1000 derivations to avoid blocking the UI thread for 1-5s on low-end Android.
10. **SSRF tightening on `api/payjoin-proxy.ts`** — reject `_path` starting with `//`, hardcode `Content-Type: message/ohttp-req` (don't echo from caller), POST-only export (no GET/PUT), `Cache-Control: no-store` on every response (including error paths). Module-load assertion that `PAYJOIN_OHTTP_RELAY` env var is `https://` with non-IP hostname.
11. **`sanitize()` is now a defined function** — closed enum only, no `err.message`, no `err.stack`, no hex strings ≥ 8 chars (catches txid / scriptPubkey / preimage leakage). Specified in §"Telemetry & event channel".
12. **Workbox config tweaks** — add `'!**/payjoin*'` to `globPatterns` so the lazy chunk is NOT precached (~2.5 MB savings on install). Switch the WASM runtime cache rule from `NetworkFirst` to `CacheFirst` since content-hashed assets are immutable; `NetworkFirst` re-fetches every navigation.
13. **PDK warm-load on review-step mount** — kick `loadPdk()` from `useEffect` when the user lands on `oc-review` with `parsed.payjoin` set. Saves 3-4s on a 4G connection vs starting the fetch on Confirm tap.
14. **Phase reorder** — ship `api/payjoin-proxy.ts` (old Phase 7) **before** Send.tsx wiring (old Phase 6) so the e2e exercise in Phase 6 hits the production wire format, not direct relay.

### New architectural seams introduced

- **`WalletScriptOracle` interface** in `proposal-validator.ts` — `isOwned(scriptPubkeyHex): boolean`. The BDK `peek_address` coupling is encapsulated behind one boundary; tests inject a fake oracle without standing up a real wallet; future BDK port lands a new oracle, not a validator rewrite.
- **`createPayjoinTransform(ctx: PayjoinContext): TransformPsbtFn`** factory exported from `src/onchain/payjoin/sender.ts`. `Send.tsx` imports the factory only; future second-library experimentation (PDK 1.0 vs 0.1.1 A/B) plugs in here.
- **`captureEvent` channel** in `src/storage/error-log.ts` for non-error structured events.
- **`src/storage/feature-flags.ts`** — central `isPayjoinDisabled()` reader. First feature flag in the codebase; sets the precedent for future flags (relay override, lookahead budget override).

### Reopened decision now resolved

**Delayed-fallback policy** — the day-prior choice ("delayed on post-encap, in-process timer") is **reverted** after deepening research surfaced that iOS Safari thaws frozen timers at unintended wallclock times (worse fingerprint than immediate broadcast; 5-15% confirmed-send-loss rate). **Final decision**: immediate broadcast on every Payjoin failure. Relay-observer fingerprint is documented as a known v1 limitation; Service Worker Background Sync is the upgrade path.

### Phase plan after deepening (6 phases, was 8)

| New | Old | Scope |
|-----|-----|-------|
| 1 | 1   | URI parsing extension (`pj=` / `pjos=`) |
| 2 | 2   | `payjoin@0.1.1` install + Vite/PWA chunk verification |
| 3 | 7   | `api/payjoin-proxy.ts` + dev proxy entry (moved earlier) |
| 4 | 3+4 | Sender state machine + persister inlined + proposal validator (now with `WalletScriptOracle`) |
| 5 | 5+6 | `transformPsbt` options-object hook + claim sentinel (per-txid, IDB-persisted) + Send.tsx wiring (privacy pill, abort, lock) + warm-load |
| 6 | 8   | Telemetry channel + sanitizer + docs + kill-switch helper |

### Key improvements

1. **Correctness**: per-txid claim sentinel (IDB) prevents double-broadcast across tab-suspend; cross-tab `navigator.locks` prevents same-tx-twice-tabs.
2. **Privacy**: adaptive UTXO probe budget (was static 10K → `max(10K, last_revealed + 5K)`); telemetry sanitizer specified, not gestured at.
3. **Performance**: fingerprint Set cached across sends; chunked derivation; PDK warm-load on review mount; Workbox `CacheFirst` for WASM.
4. **Architecture**: three named seams (`WalletScriptOracle`, `createPayjoinTransform`, `captureEvent`) instead of implicit coupling.
5. **Codebase consistency**: `loadPdk` failure-reset matches `init.ts`; outcome shape matches `PaymentResult`; feature flag centralized.
6. **TypeScript quality**: branded `PayjoinUrl`, `ProposalValidationError` base class, `as const` on `KeychainKind` arrays, options-object on `buildSignBroadcast`.
7. **Race safety**: composed `AbortSignal.any` with feature-detect fallback; mounted-ref state-set guards; `visibilitychange` debounce; defensive `.slice()` on persister `load()`.

## Overview

Re-implement Zinqq's Payjoin **sender** support against the official [`payjoin@0.1.1`](https://www.npmjs.com/package/payjoin) npm package (published 2026-05-06 by the rust-payjoin maintainers). When a user pays a BIP 321 URI that includes a `pj=` parameter, Zinqq silently coordinates a v2 (BIP 77, OHTTP-relayed) Payjoin exchange with the receiver, validates the proposed PSBT, signs and broadcasts it. On any negotiation failure the original non-Payjoin transaction is broadcast (with a randomized delay to mitigate timing-correlation fingerprinting).

The first attempt landed in PRs #139–#144 against a vendored `rust-payjoin` git submodule with a custom WASM build pipeline; it was removed in PR #147 (2026-04-30) pending upstream JS bindings — those bindings now exist as `payjoin@0.1.1`.

This plan is a substantial revision of the [superseded plan](./2026-04-23-001-feat-payjoin-send-support-plan.md). The architectural insights from that document carry forward (`transformPsbt` hook, proposal validator, claim() sentinel, `MAX_FEE_SATS` re-check), but everything related to the Rust toolchain, vendored submodule, and CI build job is dropped — that's >80% of the prior implementation surface.

Receiving Payjoin remains explicitly out of scope.

## Problem Statement / Motivation

Today, any BIP 321 URI with `pj=` is silently ignored by `parseBip321()` (`src/ldk/payment-input.ts:199-262`). The privacy implication is real: every on-chain send reveals the common-input-ownership heuristic, which lets chain surveillance cluster a user's entire wallet from a single payment. BIP 77 v2 fixes this — but only if the wallet engages it. As of May 2026, Bull Bitcoin Mobile and Cake Wallet ship v2 senders in production; not supporting it marks Zinqq as a lower-tier wallet on the privacy axis.

The brainstorm's dual motivation — _privacy by default_ and _opportunistic compatibility_ — maps to: "if `pj=` is present, use it; otherwise act as today."

## Proposed Solution

Insert an optional Payjoin path into the on-chain send pipeline between "build PSBT" and "sign + broadcast", driven by a single `transformPsbt` hook on `buildSignBroadcast`.

```
                   URI contains pj=?
                            │
                            ▼
   buildSignBroadcast(buildPsbt, feeRate, transformPsbt?)
                            │
                            ├─ build original PSBT (unsigned)
                            ├─ if transformPsbt (Payjoin path):
                            │     psbtToSign = await tryPayjoinSend(originalPsbt, ctx)
                            │       • kill-switch + pre-flight gate
                            │       • lazy-load payjoin/web-vite (~2.5 MB gzipped)
                            │       • SenderBuilder → InitialSendTransition → WithReplyKey
                            │       • POST encapsulated initial request to OHTTP relay
                            │       • Long-poll loop: PollingForProposal.createPollRequest
                            │           – fresh OHTTP encapsulation per attempt
                            │           – 30s long-poll, 1.5×30s/60s/120s/240s/480s+jitter backoff
                            │           – 5min foreground budget
                            │       • On Progress: extract proposal PSBT
                            │       • Run app-side proposal validator
                            │           – walk receiver-added inputs against peek_address(0..10_000)
                            │             on both keychains to defeat lookahead-gap UTXO probing
                            │           – sanity check fee delta ≤ build_recommended cap
                            │           – defense-in-depth on output substitution
                            │       • Returns proposal PSBT on success; throws on failure
                            │   else:
                            │     psbtToSign = original
                            ├─ MAX_FEE_SATS sanity check (re-runs on transformed PSBT)
                            ├─ wallet.sign(psbtToSign)
                            ├─ if Payjoin path: wallet.apply_unconfirmed_txs([tx])
                            └─ finalizeAndBroadcast(tx) — single broadcast tail
                              ↑
                              On Payjoin failure, fallback enters here
                              after a randomized uniform(60s, 600s) delay
```

The Payjoin path is **lazy-loaded** — zero bundle weight and zero latency for users who never pay a `pj=` URI. Users who do incur a one-time ~2.5 MB gzipped WASM fetch (cached forever via content-hashed filename).

## Technical Approach

### Library

`payjoin@0.1.1` from npm. Browser entry: `payjoin/web-vite` (uses `?url` import for the WASM, which Vite handles natively without `vite-plugin-wasm` configuration changes). The package is marked **EXPERIMENTAL** in its `package.json` — pin exact `0.1.1` and audit changelogs before bumping.

The full sender state machine, verified against the package's `payjoin.d.ts` and the rust-payjoin reference test suite:

```typescript
// 1. Parse URI
const uri = payjoin.Uri.parse(uriString)            // .d.ts:6094
const pjUri = uri.checkPjSupported()                // .d.ts:6101  → throws PjNotSupported

// 2. Build initial transition
const initial = new payjoin.SenderBuilder(psbtBase64, pjUri)   // .d.ts:5930
  .buildRecommended(minFeeRateSatVb)               // .d.ts:5947  → InitialSendTransition

// 3. Persist & advance to WithReplyKey
const persister = new InMemorySenderPersister()
const withReplyKey = initial.save(persister)        // .d.ts:5547  → WithReplyKey

// 4. Encapsulate initial POST
const { request, ohttpCtx } =
  withReplyKey.createV2PostRequest(OHTTP_RELAY)     // .d.ts:5098

// 5. POST and process response → enter polling state
const respBytes = await postRelay(request)
const polling = withReplyKey
  .processResponse(respBytes, ohttpCtx)             // .d.ts:5104
  .save(persister)                                  // → PollingForProposal

// 6. Long-poll loop (CRITICAL: fresh encapsulation per iteration)
while (deadline > Date.now()) {
  const { request, ohttpCtx } = polling.createPollRequest(OHTTP_RELAY)  // .d.ts:4061
  const respBytes = await postRelay(request, signal)  // 30s long-poll server-side
  const outcome = polling.processResponse(respBytes, ohttpCtx).save(persister)
  if (outcome.tag === 'Progress') {
    return outcome.inner.psbtBase64                 // .d.ts:4106
  }
  // Stasis: re-poll (PDK keeps state internally)
  await sleepWithBackoff(attempt++)
}
```

**Sender PSBT validation is fully delegated to PDK.** All BIP 78 sender-checklist rules (input/output preservation, fee enforcement, sighash preservation, BIP32 derivation paths, output substitution rules) are enforced inside `processResponse`. If `processResponse` returns successfully, the proposal PSBT has passed every BIP 78 sender-side check. **Exception:** receiver-input ownership detection is NOT done by PDK — it's the wallet's responsibility (see "Receiver UTXO ownership check" below).

### Module structure

```
src/onchain/payjoin/
  ├── pdk-loader.ts         (lazy `payjoin/web-vite` import + uniffiInitAsync singleton, with failure-reset)
  ├── pdk-loader.test.ts
  ├── sender.ts             (state machine + polling loop + createPayjoinTransform factory)
  ├── sender.test.ts
  ├── proposal-validator.ts (WalletScriptOracle interface + receiver UTXO ownership check)
  ├── proposal-validator.test.ts
  ├── errors.ts             (PayjoinError base + ProposalValidationError subclass)
  └── errors.test.ts
src/storage/
  ├── feature-flags.ts      (isPayjoinDisabled reader; first flag in repo)
  ├── feature-flags.test.ts
  └── error-log.ts          (extended: + captureEvent for non-error structured events)
api/
  ├── payjoin-proxy.ts      (same-origin OHTTP forwarder; modeled on vss-proxy.ts)
  ├── payjoin-proxy.test.ts
  ├── health.ts             (NEW: returns { payjoin: 'on' | 'off' } from server env; co-signs kill switch)
  └── health.test.ts
```

`InMemorySenderPersister` is six lines and lives **inline** in `sender.ts` (per simplicity review — separate file would be ceremony).

Tests are sibling `*.test.ts` (per repo convention; `__tests__/` subdirs are not used). Vitest config (`vitest.config.ts:20`) includes `api/**/*.test.ts` so the proxy tests are picked up automatically.

### Components

#### 1. URI parser extension — `src/ldk/payment-input.ts`

Extend the on-chain variant of `ParsedPaymentInput`:

```typescript
// src/ldk/payment-input.ts:26-53
export type PayjoinContext = {
  url: string       // raw pj= value, e.g. https://payjo.in/LANG586Q3F5PQ#RK1Q...+OH1Q...+EX1M560Z6G
  strict: boolean   // true if pjos=0 (parsed; not enforced at runtime)
}

export type ParsedPaymentInput =
  | /* unchanged variants */
  | {
      type: 'onchain'
      address: string
      amountSats: bigint | null
      payjoin?: PayjoinContext       // NEW
    }
  | { type: 'error'; message: string }
```

Extend `parseBip321()` (`src/ldk/payment-input.ts:199-262`) — the existing manual RFC 3986 query loop already preserves literal `+` (per [solution doc](../solutions/integration-issues/bip321-pj-urlsearchparams-plus-corruption.md)). Add two cases inside the loop:

```typescript
// Inside the existing for-of pair loop, alongside lno/lightning/amount:
else if (lowerKey === 'pj') pjValue = value
else if (lowerKey === 'pjos') pjosValue = value
```

After the loop, attach `payjoin` to the `onchain` return when present:

```typescript
let payjoinCtx: PayjoinContext | undefined
if (pjValue && pjValue.length > 0 && pjValue.length < 2048) {
  // No scheme/shape validation here — defer to payjoin.Uri.parse() at send time.
  // Length cap defends against pathological URIs.
  payjoinCtx = { url: pjValue, strict: pjosValue === '0' }
}

return { type: 'onchain', address, amountSats, payjoin: payjoinCtx }
```

Lightning takes precedence over on-chain (existing behavior); `payjoin` only attaches to the on-chain branch.

##### Test cases (`src/ldk/payment-input.test.ts`)

- `pj=https://btcpay.example/payjoin/xyz` → attached
- `PJ=https://...` (case-insensitive) → attached
- `pj=` empty → silently dropped
- `pj=...&pjos=0` → `strict: true`
- v2 URI with literal `+` in fragment (BIP 77 separator) — regression test from the solution doc
- pj-value at exactly 2047 chars → attached; at 2048 → dropped
- Both `pj=` and `lightning=` present → Lightning wins; `payjoin` not attached

#### 2. PDK loader — `src/onchain/payjoin/pdk-loader.ts`

```typescript
// Mirrors the failure-reset pattern in src/ldk/init.ts:156-167.
// uniffiInitAsync is NOT idempotent on payjoin/web-vite — must single-flight.
let pdkInitPromise: Promise<typeof import('payjoin/web-vite')> | null = null

export function loadPdk(): Promise<typeof import('payjoin/web-vite')> {
  if (!pdkInitPromise) {
    pdkInitPromise = (async () => {
      const mod = await import('payjoin/web-vite')
      await mod.uniffiInitAsync()
      return mod
    })().catch((err) => {
      pdkInitPromise = null  // permit retry on next call
      throw err
    })
  }
  return pdkInitPromise
}

/** Warm-load hook — kicked from useEffect on Send.tsx oc-review mount when payjoin is set. */
export function warmLoadPdk(): void {
  void loadPdk().catch(() => { /* surface on actual send attempt */ })
}
```

#### 3. Sender state machine — `src/onchain/payjoin/sender.ts`

```typescript
import { loadPdk } from './pdk-loader'
import { captureError, captureEvent } from '../../storage/error-log'
import { isPayjoinDisabled } from '../../storage/feature-flags'
import { MIN_FEE_RATE_SAT_VB } from '../config'
import { ProposalValidationError } from './errors'
import { validateProposal, type WalletScriptOracle } from './proposal-validator'
import type { Psbt, Wallet, FeeRate } from '@bitcoindevkit/bdk-wallet-web'

// ───── types ─────

/** Branded URL — minted only inside parseBip321; downstream code can't pass arbitrary strings. */
export type PayjoinUrl = string & { readonly __brand: 'PayjoinUrl' }

/** Discriminated outcome matching the PaymentResult shape in src/ldk/ldk-context.ts:20. */
export type PayjoinOutcome =
  | { status: 'success'; proposalPsbtBase64: string }
  | { status: 'fallback'; reason: FallbackReason }

/** Collapsed from prior 11 reasons to 7 per simplicity review; further collapse if telemetry shows hot category. */
export const FALLBACK_REASON = {
  killSwitch: 'kill_switch',
  protocol: 'protocol',                 // PDK exception; URI-shape, BuildSenderError, encapsulation, response errors collapse here
  network: 'network',                   // fetch/timeout
  validation: 'validation',             // proposal-validator (incl. fee-cap from MAX_FEE_SATS upstream)
  receiverOwnedUtxo: 'receiver_owned_utxo',  // distinct because it's a privacy disaster, not a generic protocol failure
  backgrounded: 'backgrounded',         // user abort / visibility change
  unknown: 'unknown',
} as const
export type FallbackReason = (typeof FALLBACK_REASON)[keyof typeof FALLBACK_REASON]

// In-memory persister inlined here per simplicity review.
class InMemorySenderPersister implements import('payjoin/web-vite').JsonSenderSessionPersister {
  private events: string[] = []
  save(event: string): void { this.events.push(event) }
  load(): readonly string[] { return this.events.slice() }  // defensive copy
  close(): void { this.events.length = 0 }                  // best-effort heap zeroing
}

// ───── factory: createPayjoinTransform ─────

import type { TransformPsbtFn } from '../context'
export function createPayjoinTransform(
  payjoin: { url: PayjoinUrl; strict: boolean },
  oracleFactory: (wallet: Wallet) => WalletScriptOracle
): TransformPsbtFn {
  return async (originalPsbt, ctx) => {
    const outcome = await tryPayjoinSend(
      originalPsbt.serialize_base64(),
      payjoin.url,
      ctx.wallet,
      ctx.feeRateSatVb,
      ctx.signal,
      oracleFactory(ctx.wallet)
    )
    if (outcome.status === 'fallback') {
      // Telemetry — uses captureEvent (not captureError); structured fields only.
      captureEvent('Payjoin', 'fallback', { reason: outcome.reason })
      throw new ProposalValidationError(`payjoin fallback: ${outcome.reason}`)
    }
    captureEvent('Payjoin', 'success', { /* opaque elapsed-ms bucket only */ })
    // Return a discriminated TransformResult so buildSignBroadcast knows
    // to apply_unconfirmed_txs without inspecting the original arg.
    const proposed = ctx.parsePsbt(outcome.proposalPsbtBase64)
    return { kind: 'replaced', psbt: proposed }
  }
}

// ───── core: tryPayjoinSend ─────

async function tryPayjoinSend(
  originalPsbtBase64: string,
  payjoinUrl: PayjoinUrl,
  wallet: Wallet,
  feeRateSatVb: bigint,
  signal: AbortSignal,
  oracle: WalletScriptOracle
): Promise<PayjoinOutcome> {
  // Kill switch — incident-response only. Co-signed by /api/health.
  if (await isPayjoinDisabled()) {
    return { status: 'fallback', reason: FALLBACK_REASON.killSwitch }
  }

  let pdk: Awaited<ReturnType<typeof loadPdk>>
  try { pdk = await loadPdk() } catch { return { status: 'fallback', reason: FALLBACK_REASON.protocol } }

  let pjUri
  try { pjUri = pdk.payjoin.Uri.parse(payjoinUrl).checkPjSupported() }
  catch { return { status: 'fallback', reason: FALLBACK_REASON.protocol } }

  const persister = new InMemorySenderPersister()
  let withReplyKey
  try {
    withReplyKey = new pdk.payjoin.SenderBuilder(originalPsbtBase64, pjUri)
      // min_fee_rate = user's actual rate (NOT 0) — prevents receiver fee-rate downgrade
      .buildRecommended(BigInt(Math.max(Number(feeRateSatVb), Number(MIN_FEE_RATE_SAT_VB))))
      .save(persister)
  } catch { return { status: 'fallback', reason: FALLBACK_REASON.protocol } }

  // Initial POST + polling loop — extracted to pollUntilProgress for testability.
  // Returns proposal PSBT base64 string or throws.
  const proposalB64 = await pollUntilProgress(pdk, withReplyKey, persister, signal)

  // Validate against ownership oracle. Throws ProposalValidationError on probe match.
  validateProposal(originalPsbtBase64, proposalB64, oracle)

  return { status: 'success', proposalPsbtBase64: proposalB64 }
}
```

The polling loop is extracted to `pollUntilProgress(pdk, withReplyKey, persister, signal)` for unit testability — see Phase 4 exit criteria. Each iteration mints a **fresh** OHTTP encapsulation via `polling.createPollRequest(OHTTP_RELAY)`. **The same `request.body` is never sent twice** (per OHTTP privacy property; `.d.ts:5094-5096`). A `WeakSet<ArrayBuffer>` guard rejects accidental retransmission inside the poll-fetch wrapper as belt-and-braces.

The session and persister are GC'd when `tryPayjoinSend` returns. No IndexedDB; no cross-reload recovery.

##### Polling cadence

| Attempt | Delay before request | Cumulative wallclock |
|---------|----------------------|----------------------|
| 1       | 0                    | 0s                   |
| 2       | jitter(30s ± 20%)    | ~30s                 |
| 3       | jitter(60s ± 20%)    | ~90s                 |
| 4       | jitter(120s ± 20%)   | ~210s                |
| 5+      | jitter(240s ± 20%)   | abort at 300s        |

Per request: `AbortSignal.any([userSignal, AbortSignal.timeout(60_000)])`. Foreground budget caps total at 5 minutes. Each attempt mints a fresh `createPollRequest(OHTTP_RELAY)` — **never reuse a previous OHTTP encapsulation** (privacy property of OHTTP requires one-shot ciphertext; warned at .d.ts:5094-5096).

##### Abort triggers

- User navigates away from Send (component unmount)
- `visibilitychange` event with `document.hidden === true`
- `beforeunload` event
- Explicit user cancel button (future; not in MVP)

All composed via `AbortSignal.any([...])` (Safari ≥ 17.4, supported in Zinqq's PWA target).

##### Errors → fallback reasons

| PDK exception            | FallbackReason          | User-facing? |
|--------------------------|-------------------------|--------------|
| `PjNotSupported`         | `uriShape`              | No           |
| `BuildSenderError`       | `protocol`              | No           |
| `FeeRateError`           | `protocol`              | No           |
| `EncapsulationError`     | `protocol`              | No           |
| `ResponseError::WellKnown` | `protocol` (log msg)  | Yes (toast)  |
| `ResponseError::Validation` / `::Unrecognized` | `protocol` | No |
| `ValidationError`        | `validation`            | No           |
| `fetch` network failure  | `network`               | No           |
| `AbortSignal` timeout    | `timeout`               | No           |
| User abort               | `backgrounded`          | No           |

`WellKnown` is documented as user-displayable (.d.ts:178). Surface its message via the existing `captureError` warning toast pattern; do not surface internal validation/protocol details.

#### 4. Proposal validator — `src/onchain/payjoin/proposal-validator.ts`

PDK enforces all BIP 78 PSBT structure rules (input/output preservation, fee enforcement, sighash, BIP32 paths, output substitution rules). The validator covers what PDK does NOT: **receiver-owned-UTXO probe defense (the lookahead gap)**.

The threat: a receiver who has interacted with our wallet (or crawled the chain matching our descriptor) crafts a proposal whose "receiver inputs" include a UTXO at one of our own derivation indexes that's beyond `is_mine`'s revealed window. We sign; the receiver now has a confirmed on-chain link from us to that UTXO. **Privacy disaster** — exactly what Payjoin is supposed to prevent.

##### `WalletScriptOracle` seam

The validator depends on an interface, not on BDK directly. This isolates the BDK-0.3 coupling at one boundary:

```typescript
// src/onchain/payjoin/proposal-validator.ts
export interface WalletScriptOracle {
  /** Returns true iff `scriptPubkeyHex` matches an address derived under either keychain
   *  within the budget window; false otherwise. Implementations may cache. */
  isOwned(scriptPubkeyHex: string): boolean
}
```

##### BDK 0.3 implementation — `BdkPeekOracle`

```typescript
import { KeychainKind } from '@bitcoindevkit/bdk-wallet-web'

export class BdkPeekOracle implements WalletScriptOracle {
  private cache: { key: string; set: Set<string> } | null = null
  private constructor(private readonly wallet: Wallet) {}

  static async build(wallet: Wallet): Promise<BdkPeekOracle> {
    const o = new BdkPeekOracle(wallet)
    await o.refresh()
    return o
  }

  /** Adaptive budget: max(BASE, last_revealed + HEADROOM) per keychain.
   *  BASE = 10_000 floor; HEADROOM = 5_000 to cover sync-during-send race. */
  async refresh(): Promise<void> {
    const lastExt = wallet.derivation_index(KeychainKind.External) ?? 0n
    const lastInt = wallet.derivation_index(KeychainKind.Internal) ?? 0n
    const cacheKey = `${lastExt}:${lastInt}`
    if (this.cache?.key === cacheKey) return  // idempotent

    const set = new Set<string>()
    for (const [keychain, last] of [
      [KeychainKind.External, lastExt],
      [KeychainKind.Internal, lastInt],
    ] as const) {
      const budget = Math.max(10_000, Number(last) + 5_000)
      for (let i = 0; i < budget; i++) {
        const info = this.wallet.peek_address(keychain, i)
        set.add(info.address.script_pubkey().to_hex())
        // Yield every 1000 to unblock UI thread (perf review §7).
        if ((i & 1023) === 0) await new Promise((r) => setTimeout(r, 0))
      }
    }
    this.cache = { key: cacheKey, set }
  }

  isOwned(scriptPubkeyHex: string): boolean {
    return this.cache?.set.has(scriptPubkeyHex) ?? false
  }
}
```

The cache survives across sends within a session. On the second-and-later Payjoin in the same session, `refresh()` is a no-op if `derivation_index` hasn't moved → ~0ms cost (perf review §1).

##### `validateProposal`

```typescript
export function validateProposal(
  originalPsbtBase64: string,
  proposalPsbtBase64: string,
  oracle: WalletScriptOracle
): void {
  // Decode both PSBTs (helper omitted)
  const originalInputOutpoints = new Set(
    decodePsbt(originalPsbtBase64).inputs.map(i => `${i.txid}:${i.vout}`)
  )
  for (const input of decodePsbt(proposalPsbtBase64).inputs) {
    const op = `${input.txid}:${input.vout}`
    if (originalInputOutpoints.has(op)) continue  // sender input
    const witnessUtxo = input.witness_utxo
    if (!witnessUtxo) {
      throw new ProposalValidationError('receiver input missing witness_utxo')
    }
    if (oracle.isOwned(witnessUtxo.script_pubkey_hex)) {
      throw new ProposalValidationError('receiver-input-matches-our-descriptor')
    }
  }
}
```

**Note**: per simplicity review §8, the validator does **not** include a fee-cap re-check. PDK enforces `build_recommended` cap internally; `MAX_FEE_SATS` in `buildSignBroadcast` re-runs on the transformed PSBT for free. Three layers was redundant.

##### Cost & sequencing

- Initial fingerprint build: 20,000 to 30,000 `peek_address` calls. Estimated 1-2s on desktop, 2-4s on mid-range Android, up to 5-10s on low-end Android (perf review §1). One-time per session.
- Subsequent sends: ~0ms (cache hit) unless the wallet's revealed index advanced.
- Sequencing: `BdkPeekOracle.build()` runs **in parallel** with the initial PDK POST encapsulation. With the 30-90s relay long-poll dominating wallclock, fingerprint cost is fully hidden on first attempt.

##### Test cases

- Receiver input at index 5,000 (within budget) → caught
- Receiver input at index 9,999 with `last_revealed_external = 4_500` → budget computed as max(10K, 4.5K+5K)=10K → caught
- Receiver input at index 14,999 with `last_revealed_external = 9_999` → budget max(10K, 9.9K+5K)=14.9K+epsilon → boundary; re-test
- Receiver input at index 999,999 (well beyond) → **missed** (acceptable; document)
- Receiver input matches a sender-original outpoint → skipped (correct)
- Receiver input has no `witness_utxo` → caught (defensive)
- Cache hit on second call without `derivation_index` advance → no derivations performed

#### 5. `transformPsbt` hook — `src/onchain/context.tsx`

Convert `buildSignBroadcast` to options-object signature (per Kieran §8 and architect §1) and use a discriminated `TransformResult` so `apply_unconfirmed_txs` doesn't need to inspect the original arg:

```typescript
// src/onchain/context.tsx (modified)
type TransformResult =
  | { kind: 'replaced'; psbt: Psbt }   // wallet didn't build this; need apply_unconfirmed_txs
  | { kind: 'unchanged'; psbt: Psbt }  // wallet built it; no apply needed

export type TransformPsbtFn = (
  unsigned: Psbt,
  ctx: {
    wallet: Wallet
    feeRateSatVb: bigint
    signal: AbortSignal
    parsePsbt: (base64: string) => Psbt
  }
) => Promise<TransformResult>

type BuildSignBroadcastOpts = {
  buildPsbt: (feeRate: FeeRate) => Psbt
  feeRateSatVb?: bigint
  transformPsbt?: TransformPsbtFn
  signal?: AbortSignal
}

const buildSignBroadcast = useCallback(
  async (opts: BuildSignBroadcastOpts): Promise<string> => {
    const wallet = walletRef.current!
    const esplora = esploraRef.current!
    const signal = opts.signal ?? new AbortController().signal

    // ... existing wallet/fee resolution ...
    const resolvedFeeRate = opts.feeRateSatVb ?? (await getFeeRate())
    const original = opts.buildPsbt(new FeeRate(resolvedFeeRate))

    const result: TransformResult = opts.transformPsbt
      ? await opts.transformPsbt(original, {
          wallet, feeRateSatVb: resolvedFeeRate, signal,
          parsePsbt: (b64) => Psbt.from_base64(b64),
        })
      : { kind: 'unchanged', psbt: original }
    const psbtToSign = result.psbt

    if (psbtToSign.fee().to_sat() > MAX_FEE_SATS) {
      discardStagedChanges(wallet)
      throw new Error(`Fee too high: ${formatBtc(psbtToSign.fee().to_sat())} exceeds safety limit`)
    }
    wallet.sign(psbtToSign, new SignOptions())
    const tx = psbtToSign.extract_tx()
    if (result.kind === 'replaced') wallet.apply_unconfirmed_txs([tx])

    // Cross-tab + cross-suspend single-broadcast guarantee — see "Claim sentinel" below.
    const txid = tx.compute_txid().toString()
    if (!(await claimBroadcast(txid))) return txid  // already broadcast (or in-flight) elsewhere

    // ... existing broadcast/persist tail ...
    await esplora.broadcast(tx)
    persistChangeset(wallet)
    syncHandleRef.current?.syncNow()
    return txid
  },
  []
)
```

Extend `sendToAddress`'s API to accept the same options-object trailing arg:

```typescript
sendToAddress(address: string, amountSats: bigint, opts?: {
  feeRateSatVb?: bigint
  transformPsbt?: TransformPsbtFn
  signal?: AbortSignal
})
```

`sendMax` does not gain Payjoin support (Payjoin on `drain_wallet` is out of scope).

##### Claim sentinel — per-txid, IDB-persisted, cross-tab-locked

A naive `let claimed = false` per-call sentinel does nothing useful (single broadcast site per call). Module-scope locks out retries permanently after first failure. Both shapes are wrong (julik §2). The correct shape:

```typescript
// src/onchain/payjoin/claim.ts
import { idbPut, idbGet } from '../../storage/idb'
const STORE = 'broadcast_claims'  // schema: txid -> { claimedAt: number }

/** Returns true if THIS call won the claim; false if already claimed. */
export async function claimBroadcast(txid: string): Promise<boolean> {
  // Cross-tab safety: Web Locks API guarantees serialization across same-origin tabs.
  return navigator.locks.request(`zinqq:broadcast:${txid}`, { mode: 'exclusive' }, async () => {
    const existing = await idbGet<{ claimedAt: number }>(STORE, txid)
    if (existing) return false
    await idbPut(STORE, txid, { claimedAt: Date.now() })
    return true
  })
}
```

This survives:
- **Tab suspension mid-broadcast** — IDB persists; resume reads existing claim and bails.
- **User taps Confirm twice across tabs** — Web Locks serializes; first wins, second sees the IDB row and bails.
- **Retry after failure** — different signed PSBTs produce different txids, so retries don't collide with prior failed attempts.

##### Fallback path — immediate broadcast (per Resolved Decisions §1)

```typescript
async function onPayjoinFallback(originalTx: Tx, reason: FallbackReason): Promise<string> {
  captureEvent('Payjoin', 'fallback', { reason })  // structured; no err.message
  const txid = originalTx.compute_txid().toString()
  if (!(await claimBroadcast(txid))) return txid
  await esplora.broadcast(originalTx)
  return txid
}
```

The relay-observer "Payjoin attempt at T, on-chain broadcast at T+30s" fingerprint is acknowledged as a known v1 limitation. Documented in `docs/solutions/integration-issues/payjoin-fallback-fingerprint.md`. Service Worker Background Sync is a follow-on PR if user research shows the fingerprint exploited.

#### 6. Send.tsx wiring

##### Privacy pill — `src/pages/Send.tsx:867-887` (Review screen)

Add a row between the Network fee row (882) and the `<hr>` (883). **Render-timing refinement** (security review P2.2): only show the pill once the PDK has loaded and the URI has parsed cleanly — not preemptively on URI presence. This breaks a screen-recorder side-channel and prevents the pill from "lying" if PDK load fails.

```tsx
const [pjArmed, setPjArmed] = useState(false)
useEffect(() => {
  if (sendStep.type === 'oc-review' && sendStep.payjoin) {
    warmLoadPdk()  // kick the 2.5MB chunk fetch
    void loadPdk()
      .then((pdk) => { try { pdk.payjoin.Uri.parse(sendStep.payjoin!.url).checkPjSupported(); setPjArmed(true) } catch {} })
      .catch(() => { /* leave pjArmed=false; falls back silently */ })
  }
  return () => setPjArmed(false)
}, [sendStep])

{pjArmed && (
  <div className="flex items-center justify-between text-sm">
    <span className="text-muted-foreground">Privacy</span>
    <span className="flex items-center gap-2">
      <span className="size-2 rounded-full bg-emerald-500" aria-hidden />
      <span>Payjoin</span>
    </span>
  </div>
)}
```

The pill is removed before the success toast on fallback (set `pjArmed=false` in the catch arm of `handleOcConfirm`).

##### `oc-review` step extension

Add `payjoin?: PayjoinContext` to the `oc-review` variant in the `SendStep` discriminated union (`Send.tsx:27-70`). Plumb it from `parseBip321` → step transition (line 366 / 390 today).

##### `handleOcConfirm` — abort plumbing with debouncing, mounted-ref, and Web Locks

```tsx
const abortRef = useRef<AbortController | null>(null)
const mountedRef = useRef(true)

useEffect(() => {
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  // Debounce visibilitychange — iOS app-switcher gestures fire spurious hides (julik §7).
  const onVis = () => {
    if (document.hidden) {
      hideTimer = setTimeout(() => {
        if (document.hidden) abortRef.current?.abort()
      }, 1500)
    } else if (hideTimer) {
      clearTimeout(hideTimer); hideTimer = null
    }
  }
  const onUnload = () => abortRef.current?.abort()
  document.addEventListener('visibilitychange', onVis)
  window.addEventListener('beforeunload', onUnload)
  return () => {
    if (hideTimer) clearTimeout(hideTimer)
    abortRef.current?.abort()
    document.removeEventListener('visibilitychange', onVis)
    window.removeEventListener('beforeunload', onUnload)
    mountedRef.current = false  // gate post-await setSendStep
  }
}, [])

const handleOcConfirm = async () => {
  if (sendStep.type !== 'oc-review' || sendingRef.current) return
  sendingRef.current = true
  setIsBroadcasting(true)
  abortRef.current = new AbortController()
  try {
    const transform = sendStep.payjoin
      ? createPayjoinTransform({ url: sendStep.payjoin.url as PayjoinUrl, strict: sendStep.payjoin.strict }, BdkPeekOracle.build)
      : undefined
    const txid = sendStep.isSendMax
      ? await onchain.sendMax(sendStep.address, { feeRateSatVb: sendStep.feeRate })
      : await onchain.sendToAddress(sendStep.address, sendStep.amount, {
          feeRateSatVb: sendStep.feeRate,
          transformPsbt: transform,
          signal: abortRef.current.signal,
        })
    if (mountedRef.current) setSendStep({ type: 'oc-success', txid })
  } catch (err) {
    if (mountedRef.current) setSendStep({ type: 'error', message: err.message, retryStep: sendStep })
  } finally {
    if (mountedRef.current) {
      sendingRef.current = false
      setIsBroadcasting(false)
    }
  }
}
```

##### `AbortSignal.any` browser support

Verify in Phase 2: confirm the project's browserslist target is `iOS ≥ 17.4` (when `AbortSignal.any` shipped). If older iOS is in target, add a 10-line manual implementation:

```typescript
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  const ctrl = new AbortController()
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(s.reason); break }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true })
  }
  return ctrl.signal
}
```

##### Phased UI hint during long-poll

The Confirm-tap-to-success wallclock can be 30-90s on a cooperative receiver. A static spinner looks broken. Phased copy (perf review §3):

- 0-3s: "Building transaction"
- 3-10s: "Negotiating private payment"
- 10-90s: "Waiting for receiver"
- 90s+: "Still negotiating, this can take a few minutes"

#### 7. Same-origin proxy — `api/payjoin-proxy.ts`

##### Decision: keep the proxy

Research confirmed `payjo.in` returns `Access-Control-Allow-Origin: *`, so a proxy is **not strictly required**. The simplicity review pushed to drop it; the security review reinforced the SSRF/header/CSP value of keeping it. **We keep the proxy** for: single CSP truth (`connect-src 'self'`), future-relay flexibility, defense-in-depth, and consistency with the four existing same-origin proxies.

##### Implementation (POST-only, hardened)

```typescript
// api/payjoin-proxy.ts
// Module-load assertion: env var must be a valid https URL with a non-IP hostname.
const UPSTREAM = (() => {
  const raw = process.env.PAYJOIN_OHTTP_RELAY ?? 'https://payjo.in'
  const url = new URL(raw)
  if (url.protocol !== 'https:') throw new Error('PAYJOIN_OHTTP_RELAY must be https://')
  if (/^\d+(\.\d+){3}$/.test(url.hostname) || /^\[/.test(url.hostname)) {
    throw new Error('PAYJOIN_OHTTP_RELAY hostname must not be a literal IP')
  }
  return url
})()
const TIMEOUT_MS = 90_000
const MAX_BODY_BYTES = 65_536  // OHTTP messages are tiny

const NO_STORE = { 'Cache-Control': 'no-store' } as const

// Validate the path: must start with a single '/' followed by a non-'/' char.
// Disallow `//` (protocol-relative escape), `..`, and anything outside a tight charset.
function isValidOhttpPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) return false
  if (path.includes('..')) return false
  return /^\/[A-Za-z0-9._\-/+%]+$/.test(path)
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = url.searchParams.get('_path') ?? ''
  if (!isValidOhttpPath(path)) {
    return Response.json({ error: 'Bad proxy URL — expected /<ohttp-relay-path>' }, { status: 400, headers: NO_STORE })
  }

  const body = await request.arrayBuffer()
  if (body.byteLength > MAX_BODY_BYTES) {
    return Response.json({ error: 'Body too large' }, { status: 413, headers: NO_STORE })
  }

  const upstreamUrl = new URL(path, UPSTREAM)
  // Defense in depth: confirm host equality (catches `?_path=//attacker/foo` even though our regex already rejects it).
  if (upstreamUrl.host !== UPSTREAM.host) {
    return Response.json({ error: 'host mismatch' }, { status: 400, headers: NO_STORE })
  }

  const upstream = await fetch(upstreamUrl, {
    method: 'POST',
    // CRITICAL: hardcode Content-Type — never echo from caller (security review P1.1).
    headers: { 'Content-Type': 'message/ohttp-req' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'manual',
    cache: 'no-store',
    keepalive: false,
  })
  if (upstream.status >= 300 && upstream.status < 400) {
    return Response.json({ error: 'redirect blocked' }, { status: 502, headers: NO_STORE })
  }

  return new Response(await upstream.arrayBuffer(), {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'message/ohttp-res',
      'Cache-Control': 'no-store',
    },
  })
}

// NOTE: do NOT export GET/PUT. Methods other than POST should not reach this handler.
```

##### SSRF hardening (deepened)

- **Hardcoded UPSTREAM env var, validated at module load** (https only, no IP literal).
- **POST-only export** — no GET/PUT (security review P1.1).
- **`isValidOhttpPath`** rejects `//` prefix, `..`, and any char outside `[A-Za-z0-9._\-/+%]`.
- **Hardcoded `Content-Type: message/ohttp-req`** — caller cannot tunnel arbitrary types.
- **`redirect: 'manual'`** + 3xx-rejection.
- **Host equality check** (defense in depth).
- **65KB body cap**.
- **90s upstream timeout** (long-poll headroom).
- **`Cache-Control: no-store`** on every response (200 + error paths) to prevent edge-cache poisoning.
- **`cache: 'no-store'`, `keepalive: false`** on upstream fetch to prevent HTTP/2 / 0-RTT body replay (security review P1.4).
- **No `Idempotency-Key` header**, no caller-controlled headers forwarded.

##### Workbox exclusion for the proxy URL

Add a `runtimeCaching` exclusion in `vite.config.ts` so the service worker NEVER intercepts `/api/payjoin-proxy*`:

```typescript
runtimeCaching: [
  // existing rules ...
  {
    urlPattern: ({ url }) => url.pathname.startsWith('/api/payjoin-proxy'),
    handler: 'NetworkOnly',  // explicit; never cache, never replay
  },
],
```

This guards against any future Workbox rule (or default behavior) that might layer caching/retry on the proxy and accidentally re-send an OHTTP encapsulation, breaking the privacy property.

##### Rate limiting

Skipped for MVP. Vercel's per-IP DDoS protection covers the floor. Add a durable Vercel KV bucket only if production traffic shows abuse.

##### Vercel rewrite

`vercel.json` already wires `/api/*` to the matching `api/*.ts` file via the catch-all rewrite — no rewrite addition needed. Confirm with a curl smoke test in preview before merge:

```sh
curl -i -X POST 'https://<preview>.vercel.app/api/payjoin-proxy?_path=/.well-known/ohttp-gateway' \
  -H 'Content-Type: message/ohttp-req' --data-binary @test-encapsulation.bin
```

##### Dev parity

Add to `vite.config.ts:121-136` `server.proxy`:

```typescript
'/api/payjoin-proxy': {
  target: 'https://payjo.in',
  changeOrigin: true,
  secure: true,
  rewrite: (path) => {
    const u = new URL(path, 'http://x')
    return u.searchParams.get('_path') ?? '/'
  },
}
```

Tested locally during Phase 2.

#### 8. CSP & Workbox — three targeted tweaks

- **CSP** (`vercel.json:32`): no change to `connect-src`. Same-origin proxy is covered by `'self'`. **Phase 2 verification**: confirm `payjoin/web-vite` does not pull source maps from external CDNs (security review P2.4). If it does, vendor or strip them in production build — do **not** add CDN to `connect-src`.
- **Workbox `globPatterns` exclusion** — exclude the lazy payjoin chunk from install-time precache. Adding 2.5MB to install for a feature <5% of users will hit is wasteful (Vite WASM research §6, §7).
  ```typescript
  globPatterns: [
    '**/*.{js,css,html,ico,png,svg,woff2}',
    '!**/payjoin*',  // exclude lazy Payjoin JS chunk; runtime cache will pick it up on first use
  ],
  ```
- **Workbox WASM runtime cache: `NetworkFirst` → `CacheFirst`** — content-hashed assets are immutable by definition. `NetworkFirst` re-fetches every navigation (perf review §10):
  ```typescript
  runtimeCaching: [
    {
      urlPattern: ({ url }) => url.pathname.endsWith('.wasm'),
      handler: 'CacheFirst',
      options: {
        cacheName: 'wasm-cache',
        expiration: { maxEntries: 5, maxAgeSeconds: 30 * 24 * 60 * 60 },
      },
    },
    // ... payjoin-proxy NetworkOnly rule above ...
  ],
  ```

`globIgnores: ['**/*.wasm']` already excludes the WASM chunk from precache; verified in Phase 2 against `dist/` output.

#### 9. Telemetry & event channel

Extend `src/storage/error-log.ts` with a sibling `captureEvent` for non-error structured events. Routing successes through `captureError('warning', ...)` is wrong on two axes (architect §6, pattern §4): semantic mislabel (success ≠ warning) and channel reuse for fingerprintable events.

```typescript
// src/storage/error-log.ts (extended)
type EventFields = Record<string, string | number>
export function captureEvent(source: string, kind: string, fields?: EventFields): void {
  // Separate IDB store from error log; pruned at 200 entries.
  const sanitized = fields ? sanitizeEventFields(fields) : undefined
  void idbPut('zinqq_event_log', randomId(), { source, kind, fields: sanitized, ts: Date.now() })
}
```

##### `sanitize()` — defined, not gestured at

```typescript
// src/storage/error-log.ts
const HEX_RE = /[0-9a-fA-F]{8,}/g  // catches txid / scriptPubkey / preimage / pubkey leakage

function sanitizeEventFields(fields: EventFields): EventFields {
  const out: EventFields = {}
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'number') { out[k] = v; continue }
    // String values: strip hex blobs ≥ 8 chars; reject long strings; reject obvious URLs.
    if (v.length > 256) continue
    if (/^https?:|^bitcoin:|^payjoin:/i.test(v)) continue
    out[k] = v.replace(HEX_RE, '<redacted>')
  }
  return out
}
```

Call sites:

```typescript
// On success:
captureEvent('Payjoin', 'success', { attempts, elapsedMsBucket: bucketize(ms) })
// On fallback:
captureEvent('Payjoin', 'fallback', { reason, attempts })
```

`captureError` is reserved for actual exceptions. The two channels write to separate IDB stores; future debug-bundle export can include or exclude either independently.

### Implementation Phases (6 phases after deepening)

#### Phase 1 — URI parsing (1-2 hours) ✅ shipped

- [x] Extend `ParsedPaymentInput.onchain` with `payjoin?: PayjoinContext`
- [x] Brand `PayjoinUrl = string & { __brand: 'PayjoinUrl' }`; mint only inside `parseBip321`
- [x] Plumb `pj=`/`pjos=` through `parseBip321` (reuses existing query loop)
- [x] Tests: 7 cases (incl. literal-`+` regression; case-insensitive; length cap)
- [x] No functional behavior change — `payjoin` is parsed but unused

**Exit criteria:** `pnpm test src/ldk/payment-input.test.ts` green ✅ (22/22); `pnpm typecheck` clean ✅; full suite 451/451 ✅.

#### Phase 2 — Library install + Vite/PWA verification (3-5 hours)

- `pnpm add payjoin@0.1.1` (pin exact)
- Stub `loadPdk()` (`pdk-loader.ts` with failure-reset; mirror `src/ldk/init.ts:156-167`)
- Build (`pnpm build`); inspect `dist/assets/` for the WASM chunk filename, JS chunk size, content hash
- **Verify Workbox tweaks**: `globIgnores: ['**/*.wasm']` excludes WASM; `globPatterns` exclusion `'!**/payjoin*'` excludes JS chunk; `CacheFirst` runtime rule emits.
- **Verify CSP**: confirm `payjoin/web-vite` does NOT pull external source maps. If it does, strip in production.
- **Verify `AbortSignal.any` browserslist alignment**; add `anySignal()` polyfill if iOS < 17.4 in target.
- **Verify `payjoin/web-vite` typechecks**: if subpath import doesn't resolve, add ambient `.d.ts`.

**Exit criteria:** `pnpm build` succeeds; main bundle delta ≤ 5 KB gzipped; lazy chunk content-hashed and in own file ≤ 3 MB gzipped; `pnpm typecheck` green; manual smoke `await import('payjoin/web-vite')` from devtools resolves.

#### Phase 3 — `api/payjoin-proxy.ts` + `api/health.ts` + dev proxy (4-6 hours) — **moved from old Phase 7**

- `api/payjoin-proxy.ts` POST-only, hardened SSRF (module-load env validation, `_path` regex with `//` rejection, hardcoded `Content-Type: message/ohttp-req`, `Cache-Control: no-store` everywhere, `redirect: 'manual'`, `cache: 'no-store'`, `keepalive: false`)
- `api/health.ts` returns `{ payjoin: 'on' | 'off' }` from server env (kill-switch co-sign)
- Tests: 200 success, 400 bad path (`/`, `//`, `..`, charset), 413 oversize, 502 redirect, env-var-missing module-load failure
- Dev proxy entry in `vite.config.ts:121-136`
- Workbox `runtimeCaching` exclusion for `/api/payjoin-proxy` (NetworkOnly)
- Smoke test: curl preview-deploy with real OHTTP encapsulation bytes

**Exit criteria:** preview-deploy curl roundtrips encapsulated request; module-load failure on bad env var; `pnpm test api/payjoin-proxy.test.ts` green.

#### Phase 4 — Sender state machine + proposal validator (1-2 days) — **merged from old Phases 3+4**

- `src/onchain/payjoin/sender.ts` — `tryPayjoinSend`, `pollUntilProgress`, `createPayjoinTransform`, inline `InMemorySenderPersister`
- `src/onchain/payjoin/proposal-validator.ts` — `WalletScriptOracle` interface, `BdkPeekOracle` impl with adaptive budget + cache + chunked yielding, `validateProposal`
- `src/onchain/payjoin/errors.ts` — `PayjoinError` base, `ProposalValidationError`
- `src/onchain/payjoin/claim.ts` — `claimBroadcast(txid)` with `navigator.locks` + IDB
- `src/storage/feature-flags.ts` — `isPayjoinDisabled()` reader (localStorage OR `/api/health`)
- `src/storage/error-log.ts` extended with `captureEvent` + `sanitizeEventFields`
- Unit tests with `vi.hoisted` mock for `payjoin/web-vite`; PSBT fixture-based validator tests
- Tests cover: ownership probe at indexes 99 / 5000 / boundary / 999999; cache hit; cache invalidation on revealed-index advance; sender-input outpoint skip; missing witness_utxo

**Exit criteria:** all unit tests pass; smoke test against rust-payjoin reference v2 receiver running locally; `pnpm typecheck` green.

#### Phase 5 — `transformPsbt` hook + Send.tsx wiring (1 day) — **merged from old Phases 5+6**

- `buildSignBroadcast` signature: options object + discriminated `TransformResult`
- `claimBroadcast(txid)` integration in broadcast tail
- `sendToAddress` opts-object signature; `sendMax` unchanged
- `Send.tsx`: `oc-review` step gains `payjoin?: PayjoinContext`; Privacy pill with `pjArmed` gating (renders only after PDK load + URI parse succeed); `handleOcConfirm` with `mountedRef`, debounced `visibilitychange`, `AbortController` plumbing, phased UI hint copy
- `warmLoadPdk()` from `useEffect` on `oc-review` mount when payjoin set
- Fallback path skeleton — option (A) by default; switch to (B) or (C) per Resolved Decisions §1
- Tests: unit-level pill conditional render; race tests for double-Confirm; mount/unmount during in-flight; cross-tab `navigator.locks` test
- Manual e2e: cooperative receiver → success; receiver injects index-5000 ownership probe → fallback fires; deliberate relay timeout → fallback (per §1 chosen path)

**Exit criteria:** existing send tests green; new race tests pass; manual e2e against reference receiver covers all 8 integration scenarios in §"Integration Test Scenarios".

#### Phase 6 — Telemetry hardening + docs + kill-switch helper (3-5 hours)

- All `captureEvent` call sites verified against `sanitizeEventFields`
- `docs/solutions/integration-issues/payjoin-receiver-utxo-probe-defense.md` (lookahead-gap + adaptive budget rationale)
- `docs/solutions/integration-issues/payjoin-fallback-fingerprint.md` (chosen fallback policy + threat model)
- `docs/solutions/operations/payjoin-kill-switch.md` (localStorage + /api/health co-sign incident playbook)
- Frontmatter `superseded-by:` on the 2026-04-23 plan
- README feature list addition

**Exit criteria:** Code review pass with `kieran-typescript-reviewer`, `security-sentinel`, `architecture-strategist`, `code-simplicity-reviewer` (per `compound-engineering.local.md`); CI green; preview-deploy smoke test passes.

### Alternative Approaches Considered

1. **Wait for upstream `payjoin` 1.0**. Rejected — 0.1.1 covers our needs; we pin and audit on bump.
2. **Vendor the WASM bundle into `public/` and load from same-origin path** (à la liblightningjs.wasm). Rejected — Vite's `?url` import already content-hashes and emits to `/assets/`, with HTTP caching and Workbox-runtime caching. Avoids the `predev`/`prebuild` `cp` script.
3. **Drop the `/api/payjoin-proxy` endpoint and use direct `https://payjo.in` with CSP allowlist.** Rejected — single source of CSP truth (`'self'`), defense-in-depth (rate-limit, logging at edge), future-relay flexibility. ~15 LOC.
4. **Drop the receiver-owned-UTXO probe defense.** Rejected — PDK does NOT do this check (verified). The privacy harm of a missed probe is exactly what Payjoin is supposed to prevent. The 1-2s amortized cost is acceptable.
5. **Persist sessions in IndexedDB for cross-reload recovery.** Rejected per brainstorm — the UX surface (pending Payjoin badge, replay-on-reopen flow) is significantly more scope than the in-memory variant. Revisit if user research surfaces it as a top complaint.
6. **Randomized 60-600s delayed fallback (in-process timer).** Initially adopted in this plan; **reverted** after deepening research showed iOS Safari timer-thaw creates a worse fingerprint than immediate broadcast plus a 5-15% loss-of-confirmation rate. Plan now ships immediate fallback with the relay-observer fingerprint documented as a known v1 limitation; Service Worker Background Sync is the upgrade path if needed.

## System-Wide Impact

### Interaction Graph

```
User taps Confirm in oc-review
  → handleOcConfirm (Send.tsx)
    → onchain.sendToAddress(addr, amt, fee, transformPsbt, signal)
      → buildSignBroadcast(buildPsbt, fee, transformPsbt, signal)  (context.tsx)
        → buildPsbt(feeRate)  → original PSBT
        → transformPsbt(original, ctx)  → tryPayjoinSend  (payjoin.ts)
          → loadPdk()  (singleton; first call ~2.5MB fetch)
          → SenderBuilder → InitialSendTransition → WithReplyKey → encapsulate
          → fetch /api/payjoin-proxy?_path=...  → Vercel function
            → fetch https://payjo.in/...
          → processResponse → PollingForProposal
          → loop (createPollRequest → fetch → processResponse) until Progress | timeout | abort
          → buildOwnershipFingerprint(wallet)  (parallel; 1-2s)
          → validateProposal(original, proposal, wallet, feeCap, fingerprint)
        → MAX_FEE_SATS check on transformed PSBT
        → wallet.sign(psbtToSign)  (BDK)
        → wallet.apply_unconfirmed_txs([tx])  (BDK; reflects spend in balance)
        → claim() — set single-broadcast sentinel
        → esplora.broadcast(tx)
        → persistChangeset(wallet)
        → syncHandle.syncNow()
  → setSendStep('oc-success', txid)

On Payjoin failure:
  ... transformPsbt throws ...
  → mapPayjoinFallback(err)  → FallbackReason
  → if fast-fail (kill-switch/load/uri): broadcast original immediately
  → else: scheduleDelayedBroadcast(originalTx, randomUniform(60s, 600s))
    → returns success-perceived state to user
    → background timer fires; broadcasts; logs
```

### Error & Failure Propagation

- `tryPayjoinSend` catches all PDK exceptions internally, returns either `PayjoinResult` or `{ fallbackReason }`. **Never throws** — fallbacks are first-class outcomes, not errors.
- `validateProposal` throws `ProposalValidationError` — caught by `tryPayjoinSend`, mapped to `validation` fallback.
- `buildSignBroadcast` propagates only the wallet/broadcast errors (signing failures, broadcast 4xx/5xx); fallback path is a separate code arm.
- `Send.tsx` `handleOcConfirm` catches everything from `onchain.sendToAddress`, routes to the `error` step, preserves the review step for retry.

**Retry conflicts**: PDK's per-attempt fresh OHTTP encapsulation requirement means the polling loop's "retry on `fetch` 5xx" must call `createPollRequest` again, NOT reuse the previous `request.body`. Easy to get wrong; documented inline in the polling loop.

### State Lifecycle Risks

- **Double-broadcast** (Payjoin proposal + fallback original both broadcast): prevented by `claim()` sentinel inside `buildSignBroadcast`.
- **Double-claim of `wallet.sign`**: BDK's `wallet.sign(psbt, opts)` is idempotent — calling twice on the same PSBT does no harm. But signed PSBTs differ from unsigned in extracted-tx output, so two separate sign+extract calls yield two distinct txids → double-broadcast risk. Sentinel prevents this.
- **`wallet.apply_unconfirmed_txs` ordering**: must run AFTER `wallet.sign` and BEFORE `esplora.broadcast`. If we apply before broadcast, the balance reflects a pending spend that never lands (rare — broadcast 5xx). Acceptable: the next sync round-trip clears stale unconfirmed txs.
- **`take_staged` on validation failure**: when `validateProposal` throws, BDK's wallet has no staged changes (we only staged via `peek_address` which is non-destructive, and `wallet.sign` only stages on the actual proposal which we threw out). No `take_staged` cleanup needed in the validator failure path.
- **Persister disposal**: `InMemorySenderPersister` is a local variable in `tryPayjoinSend`; GC'd on return. No explicit `close()` needed; PDK calls it.
- **PDK uniffiDestroy**: long-lived Rust objects (`SenderBuilder`, `WithReplyKey`, `PollingForProposal`) are short-lived in our flow — references dropped after each `save()` consumes the prior state. Rely on FinalizationRegistry-based GC. No explicit destroy needed for the sender path.

### API Surface Parity

- `sendToAddress`: gains optional `transformPsbt` and `signal` params. Backward-compatible (existing callers unchanged).
- `sendMax`: unchanged. Payjoin on `drain_wallet` is out of scope.
- `buildSignBroadcast`: gains optional `transformPsbt` and `signal` params. Internal to `OnchainProvider`; not exposed via context.
- `OnchainContextValue`: no shape change.
- `ParsedPaymentInput.onchain`: gains optional `payjoin: PayjoinContext`. Consumers must handle absence.

No public API breakage.

### Integration Test Scenarios

1. **Happy path against rust-payjoin reference receiver** (run locally in `payjoin-cli` reference mode): user pastes URI, taps Confirm, proposal returned, validator passes, signed and broadcast. Assert: Esplora returns the proposal txid.
2. **Receiver-owned-UTXO probe at index 5,000**: malicious receiver (forked rust-payjoin reference) injects a proposal whose receiver-input matches our descriptor at index 5,000. Validator catches; fallback fires. Assert: original txid broadcasts, not the proposal.
3. **OHTTP relay 503**: `/api/payjoin-proxy` returns 503; polling retries with backoff; total budget exhausted at 5 min; fallback fires immediately. Assert: original tx broadcasts within 1s after the foreground budget exhausts.
4. **User backgrounds tab during polling**: AbortController fires; fallback fires (fast-fail; backgrounded reason). Assert: original tx broadcasts immediately. (Privacy fingerprint of "background-cancel" is acceptable; user explicitly left.)
5. **Kill switch set**: `localStorage.zinqq_payjoin_disabled=1`; tap Confirm; original tx broadcasts immediately, no PDK load. Assert: no `payjoin/web-vite` chunk fetched in Network tab.
6. **CSP violation regression**: deliberately probe a non-allowlisted host from the proxy; expect 400. Assert: no upstream call made.
7. **Workbox offline**: install PWA, complete one Payjoin send (PDK chunk now cached), go offline, attempt second Payjoin send. Assert: load from cache succeeds; user gets `network` fallback gracefully.
8. **Privacy pill render**: review screen for a `pj=`-bearing URI shows the pill; for a plain URI does not. Assert: a11y attributes correct.

## Resolved Decisions

1. **Delayed-fallback policy** ✅ — **Drop the delay entirely.** On any Payjoin failure (kill-switch, URI shape, PDK load, network, timeout, protocol, validation, receiver-owned-UTXO, abort), broadcast the original tx **immediately**. Reverses the day-prior "delayed only on post-encap" decision after research showed the in-process timer was the worst of both worlds (iOS Safari thaw creates worse fingerprint than immediate; 5-15% loss-of-confirmation rate). The relay-observer fingerprint of "saw Payjoin attempt at T, saw on-chain broadcast at T+30s" is documented as a known v1 limitation in `docs/solutions/integration-issues/payjoin-fallback-fingerprint.md`. Revisit if a real adversary materializes or wallet research shows the fingerprint exploited at scale; (B) Service Worker Background Sync is the upgrade path.
2. **Service Worker keepalive for delayed fallback** ✅ — Not applicable given §1 = immediate broadcast. No SW work in this PR.
3. **Privacy pill copy** ✅ — `Privacy: ● Payjoin` with emerald-500 dot. Two-column row matching the To / Amount / Network fee row design language. **Pill render-timing refinement** (security review P2.2): only render after the `WithReplyKey` state is entered (i.e., after PDK loaded, URI parsed, initial encapsulation succeeded). On fallback, remove the pill before the success toast. This breaks the trivial side-channel correlation that lets a screen-recording adversary distinguish Payjoin from non-Payjoin sends from the review screen alone.
4. **Kill-switch shape** ✅ — `localStorage.zinqq_payjoin_disabled = '1'`. **Hardened against XSS** (security review P2.1): the localStorage flag is OR'd with a server-side disable bit returned from a new `/api/health` endpoint (returns `{ payjoin: 'on' | 'off' }` based on a Vercel env var). Either source can disable; a same-origin XSS attacker can flip the local flag but cannot flip the server bit. Centralized in `src/storage/feature-flags.ts` (first flag in the codebase; sets the registry precedent).

## Acceptance Criteria

### Functional Requirements

- [ ] `parseBip321()` extracts `pj=` and `pjos=` and attaches a `PayjoinContext` to the on-chain variant when present.
- [ ] Pasting a v2 URI with literal `+` in the receiver-session fragment preserves the byte-exact value (regression test from [solution doc](../solutions/integration-issues/bip321-pj-urlsearchparams-plus-corruption.md)).
- [ ] On Confirm in `oc-review`, when `payjoin` is set: `tryPayjoinSend` is invoked; on success its proposal PSBT is signed and broadcast; on failure the original PSBT is signed and broadcast.
- [ ] PDK WASM is fetched lazily — only on the first Payjoin send. Verified by Network tab inspection.
- [ ] Polling loop exits cleanly on `AbortSignal` (visibilitychange / beforeunload / unmount).
- [ ] Each polling attempt mints a fresh OHTTP encapsulation; the same `request.body` is never sent twice.
- [ ] Receiver-input ownership probe defense: a proposal whose receiver-input matches a script at derivation index ≤ 10,000 on either keychain is rejected with `receiverOwnedUtxo` reason.
- [ ] Privacy pill renders on the Review screen iff `parsed.payjoin` is set.
- [ ] `localStorage.zinqq_payjoin_disabled=1` short-circuits the Payjoin path; no PDK chunk fetched.

### Non-Functional Requirements

- [ ] Bundle size: production gzipped JS bundle excluding payjoin chunk grows by < 5 KB (lazy-load gate code only).
- [ ] Lazy chunk: ≤ 3 MB gzipped. WASM chunk content-hashed and cacheable forever.
- [ ] Time-to-first-PSBT-build under no Payjoin: unchanged (no measurable regression).
- [ ] Time-to-broadcast under cooperative Payjoin: target ≤ 5 s (single relay round-trip + fingerprint build + sign).
- [ ] Time-to-broadcast under non-cooperative Payjoin: 5 min foreground budget + immediate fallback = ~5 min worst case to chain visibility.
- [ ] No raw exception messages, PSBT contents, or receiver-session URLs in `captureError` detail fields.

### Quality Gates

- [ ] `pnpm typecheck` green.
- [ ] `pnpm lint` green (lint covers `api/**/*.ts`).
- [ ] `pnpm test` green; new module coverage ≥ 80%.
- [ ] `pnpm build` green; production bundle inspected for chunk shape.
- [ ] Code review pass with `kieran-typescript-reviewer`, `security-sentinel`, `architecture-strategist`, `code-simplicity-reviewer` (per `compound-engineering.local.md`).
- [ ] CSP and CORS smoke test on Vercel preview deploy passes.
- [ ] PR description includes a one-paragraph deviation note for the delayed-fallback policy.

## Success Metrics

- **Privacy uplift**: % of on-chain sends with `pj=` parameter that successfully complete the Payjoin path (not the fallback). Target: ≥ 60% in the first 30 days of production traffic. Measured via aggregated `captureError('warning', 'Payjoin', 'success' | 'fallback:*', ...)` log analysis.
- **Latency**: p95 confirm-tap-to-success-toast for cooperative Payjoin sends. Target: ≤ 8 s.
- **Bundle**: lazy chunk fetch count vs unique users in error-log telemetry. Confirms lazy-load works (chunk count ≪ user count).
- **Incident-response readiness**: kill switch verified working in production within 7 days of deploy.

## Dependencies & Prerequisites

- `payjoin@0.1.1` published on npm (verified 2026-05-06).
- BDK 0.3 wasm exposes `peek_address` (verified — `node_modules/.../bdk-wallet-web/*.d.ts:1214`).
- Vercel preview deploys with environment variable `PAYJOIN_OHTTP_RELAY` (optional; defaults to `https://payjo.in`).
- A reference v2 receiver for integration tests — rust-payjoin's CLI or `payjoin-cli` running locally during dev. CI integration tests stub `fetch` rather than running a real receiver.

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `payjoin@0.1.1` API breaks before stabilization | Medium | High | Pin exact version; audit changelog on bump; smoke-test in preview before merge |
| OHTTP relay (`payjo.in`) goes down | Low | Medium | Single relay for MVP; future: relay fallback list (deferred) |
| Receiver-owned-UTXO probe at index > 10,000 (theoretical) | Very low | Severe | 10,000 budget covers realistic wallet usage; document constraint; revisit if user reports false-pass |
| WASM chunk unbounded growth in future versions | Medium | Low | Lazy-load amortizes cost; monitor bundle-size CI threshold |
| Delayed-fallback timer abandoned on tab close | Medium | Low | In-process timer for MVP; user can re-attempt manually; document |
| `processResponse` throws an unrecognized error type | Low | Low | Catch-all `unknown` fallback reason; structured telemetry surfaces unknown patterns |
| Sender input PSBT field validation regresses upstream in PDK | Low | Severe | Defense-in-depth via app-side fee cap + ownership probe; pinned package version |
| Service Worker race on PDK chunk fetch | Low | Low | Workbox NetworkFirst already handles; verified in Phase 2 |

## Future Considerations

- **Receiving Payjoin** (reviewer role) — explicitly out of scope. Receiver-side requires UTXO management and is a much larger feature.
- **BIP 78 v1 sender** — `payjoin@0.1.1` still doesn't expose `WithReplyKey` v1 path; revisit when upstream re-exposes.
- **Relay fallback list** — multi-relay attempts on first-relay failure. Cost: increased privacy-correlation surface (operating across two relays gives a more distinctive fingerprint than one). Deferred.
- **IndexedDB session persistence** — survives page reloads; requires `JsonSenderSessionPersisterAsync` impl + replay machinery + UI surface.
- **OHTTP key rotation handling** — relays rotate keys every 30 days. PDK extracts keys from the receiver-session URI for sender-side, so rotation only matters if a saved session URI is hours/days old. Revisit when persistence is added.
- **Telemetry export tool** — surface `Payjoin` source events as a Settings-page debug log for power users investigating their own privacy posture.
- **Lightning Payjoin (PayjoinSwap, BIP 7x)** — distinct protocol, distinct wallet integration. Not on this roadmap.

## Documentation Plan

- **`docs/solutions/integration-issues/payjoin-receiver-utxo-probe-defense.md`** (new): document the lookahead gap, why we set a 10,000 budget, and the cost trade-off. Audience: future contributors who might "optimize" the budget down.
- **`docs/solutions/integration-issues/payjoin-fallback-fingerprint-mitigation.md`** (new): document the delayed-fallback policy, why immediate fallback was rejected, and the privacy threat model. Audience: anyone who reads the code and thinks "why do we wait 60-600s?".
- **`compound-engineering.local.md`**: no change.
- **README**: add Payjoin v2 to the supported feature list.
- **`docs/plans/2026-04-23-001-feat-payjoin-send-support-plan.md`**: add a `superseded-by:` frontmatter field pointing to this plan.

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-05-07-payjoin-send-npm-package-brainstorm.md](../brainstorms/2026-05-07-payjoin-send-npm-package-brainstorm.md). Key decisions carried forward: v2-only scope, in-memory persistence, lazy-load PDK, restore Privacy → ● Payjoin pill, single-relay (payjo.in) default with env override, kill-switch via localStorage.
- **Superseded plan:** [docs/plans/2026-04-23-001-feat-payjoin-send-support-plan.md](./2026-04-23-001-feat-payjoin-send-support-plan.md). Architectural pieces carried forward: `transformPsbt` hook, `proposal-validator.ts` sibling module, claim() sentinel, `MAX_FEE_SATS` re-check, BDK lookahead-gap defense (now adapted to `peek_address`).

### Internal References

- `src/ldk/payment-input.ts:199-262` — `parseBip321` (extension point)
- `src/onchain/context.tsx:164-220` — `buildSignBroadcast` (extension point)
- `src/onchain/context.tsx:267-298` — `sendToAddress` (extension point)
- `src/pages/Send.tsx:584-605` — `handleOcConfirm` (extension point)
- `src/pages/Send.tsx:861-907` — `oc-review` render (privacy pill insertion)
- `src/storage/error-log.ts:23-28` — `captureError` (telemetry)
- `api/vss-proxy.ts` — payjoin-proxy template
- `node_modules/@bitcoindevkit/bdk-wallet-web/*.d.ts:1202,1214` — `is_mine` and `peek_address` signatures
- `vite.config.ts:121-136` — dev proxy entries
- `vite.config.ts:85-103` — Workbox config (verified no change needed)
- `vercel.json:32` — CSP (no change needed)
- `compound-engineering.local.md:11-17` — `cancelled` todo status convention
- `docs/solutions/integration-issues/bip321-pj-urlsearchparams-plus-corruption.md` — RFC 3986 query parsing rule
- `docs/solutions/integration-issues/pwa-workbox-vercel-csp-integration.md` — Workbox + CSP guidance

### External References

- [`payjoin@0.1.1` npm](https://www.npmjs.com/package/payjoin)
- [rust-payjoin GitHub — payjoin-ffi/javascript](https://github.com/payjoin/rust-payjoin/tree/master/payjoin-ffi/javascript)
- [Payjoin Dev Kit](https://payjoindevkit.org/)
- [BIP 77 spec](https://bips.dev/77/)
- [BIP 78 sender's checklist](https://github.com/bitcoin/bips/blob/master/bip-0078.mediawiki)
- [docs.rs/payjoin send/v2](https://docs.rs/payjoin/latest/payjoin/send/v2/)
- [Payjoin probing-attacks blog (2025-03-31)](https://payjoin.org/blog/2025/03/31/payjoin-probing-attacks/)
- [Bull Bitcoin v2 launch](https://www.bullbitcoin.com/blog/bull-bitcoin-wallet-payjoin)
- [Cake Wallet v2 launch](https://blog.cakewallet.com/bitcoin-privacy-takes-a-leap-forward-cake-wallet-introduces-payjoin-v2/)
- [BTCPayServer.BIP78 reference impl (C#)](https://github.com/btcpayserver/BTCPayServer.BIP78/blob/master/BIP78.Sender/PayjoinClient.cs)

### Related Work

- PR [#139](https://github.com/ConorOkus/zinqq/pull/139) — BIP 321 `pj=` parsing scaffold (now removed)
- PR [#140](https://github.com/ConorOkus/zinqq/pull/140) — original PDK vendor + loadPdk Phase 2 (removed)
- PR [#143](https://github.com/ConorOkus/zinqq/pull/143) — original BIP 77 v2 sender Phase 3 (removed)
- PR [#144](https://github.com/ConorOkus/zinqq/pull/144) — real PDK browser loader (removed)
- PR [#146](https://github.com/ConorOkus/zinqq/pull/146) — fix BIP 21 `+` corruption (still in tree, regression test reused here)
- PR [#147](https://github.com/ConorOkus/zinqq/pull/147) — full Payjoin removal pending upstream JS bindings
- Cancelled todos: #257-268 (telemetry, validator, proxy hardening) — concerns reviewed in [Learnings](#) section above; relevant items folded into Phases 4, 7, 8.
