---
title: Harden hand-rolled LSPS2 client toward LDK LSPS2ClientHandler API parity
type: refactor
status: completed
date: 2026-07-06
origin: docs/brainstorms/2026-07-06-lsps2-client-ldk-api-parity-brainstorm.md
---

# ♻️ Harden the hand-rolled LSPS2 client toward LDK API parity

## Overview

We cannot "switch to the built-in `LSPS2Client`": `lightning-liquidity`
(`LSPS2ClientHandler` / `LiquidityManager`) is **not wrapped by `ldk-c-bindings`**
and therefore ships **zero** LSPS symbols in `lightningdevkit@0.2.4-0`
(see brainstorm: `docs/brainstorms/2026-07-06-lsps2-client-ldk-api-parity-brainstorm.md`,
"Context"). Instead we adopt **Approach A**: keep the hand-rolled client
(`src/ldk/lsps2/`), reshape its public surface to mirror LDK's `LSPS2ClientHandler`
so a future swap is a re-wire rather than a rewrite, and fold in robustness +
correctness wins that pay off regardless of any future swap.

This is a **payment-path refactor**. The bar is: **no behavior change to the
happy path or to failover**, plus a strictly stronger error/config posture. All
existing tests (`jit-failover.test.ts`, `user-config.test.ts`) must keep passing
with only mechanical renames.

## Problem Statement / Motivation

- The custom client (`getOpeningFeeParams` / `buyChannel` / `createJitInvoice`)
  uses ad-hoc names/types that don't line up with LDK's vocabulary, so a future
  migration to a real `LSPS2ClientHandler` would be a rewrite.
- Errors thrown from the transport layer are untyped `new Error(...)`
  (`message-handler.ts:65,80,158,213`), so callers can't distinguish
  "timed out" from "peer disconnected" from "handler destroyed" for telemetry
  or for buy-vs-quote failover decisions.
- The 0-conf accept passes `null` config overrides (`event-handler.ts:622`) and
  relies solely on wallet-global JIT config; the 0.2 bindings now expose
  `ChannelConfigOverrides`, letting the JIT channel's requirements be stated
  explicitly at accept time.
- JIT invoice construction lives inside the client (`createJitInvoice`), which
  is *not* what LDK's handler does — LDK returns `intercept_scid` + `cltv` and
  the caller builds the invoice. Moving it out sharpens the seam.

## Proposed Solution

Rename + retype the client to mirror LDK, type the transport errors, tune the
existing timeout, wire an explicit `ChannelConfigOverrides` on 0-conf accept
(additively), and lift invoice construction to the app layer. Promise-based
internals are retained (event-model parity is explicitly out of scope — see
brainstorm "Why This Approach").

### API mapping (adopt LDK's exact names — see brainstorm: Resolved Questions)

| Current (`client.ts`) | LDK `LSPS2ClientHandler` | New name |
|---|---|---|
| `getOpeningFeeParams(lspNodeId, token)` → `OpeningFeeParams[]` | `request_opening_params(counterparty_node_id, token)` | `requestOpeningParams(counterpartyNodeId, token)` |
| `buyChannel(lspNodeId, feeParams, paymentSizeMsat)` → `BuyResponse` | `select_opening_params(counterparty_node_id, payment_size_msat, opening_fee_params)` | `selectOpeningParams(counterpartyNodeId, paymentSizeMsat, openingFeeParams)` |
| `createJitInvoice(...)` | *(caller builds invoice from `InvoiceParametersReady`)* | **move to app layer** (see Phase 3) |

Type renames in `types.ts` (mirror LDK struct/event names):
- `OpeningFeeParams` → `LSPS2OpeningFeeParams` (fields already match LDK's:
  `min_fee_msat`, `proportional`, `valid_until`, `min_lifetime`,
  `max_client_to_self_delay`, `min_payment_size_msat`, `max_payment_size_msat`,
  `promise` — confirmed against `types.ts:150-203`).
- `BuyResponse` → `LSPS2InvoiceParameters` with fields aligned to LDK's
  `InvoiceParametersReady`: `interceptScid` (was `jitChannelScid`),
  `cltvExpiryDelta` (was `lspCltvExpiryDelta`), `clientTrustsLsp`.

> These are **pure renames** — keep the raw-JSON wire serializers
> (`serializeOpeningFeeParams` / `deserializeOpeningFeeParams`) exactly as-is;
> the bLIP-52 unknown-field rejection (`types.ts:174-179`) MUST be preserved.

### Typed transport errors

Replace the four ad-hoc `new Error(...)` sites in `message-handler.ts` with a
small typed hierarchy in `src/ldk/lsps2/errors.ts`:

```ts
// src/ldk/lsps2/errors.ts
export class Lsps2TransportError extends Error {}
export class Lsps2TimeoutError extends Lsps2TransportError {}      // reaper
export class Lsps2PeerDisconnectedError extends Lsps2TransportError {}
export class Lsps2HandlerDestroyedError extends Lsps2TransportError {}
export class Lsps2BackpressureError extends Lsps2TransportError {} // per-peer cap
```

These stay **failover-eligible on the quote path** (they are non-`AbortError`,
which `runJitQuoteFlow` already treats as fallback-eligible — proven by
`jit-failover.test.ts:226`). Typing them adds telemetry precision and lets the
buy path surface a specific message without changing failover semantics.

### Timeout: tune the *existing* reaper (do not build a new one)

`message-handler.ts:36-69` already reaps pending requests
(`REQUEST_TIMEOUT_MS = 30_000`, 5s interval), caps per-peer pending
(`MAX_PENDING_PER_PEER = 10`), and cleans up on `peer_disconnected` / `destroy`.
Work here is:
- `REQUEST_TIMEOUT_MS: 30_000 → 15_000` (brainstorm decision: 15s).
- Reject with `Lsps2TimeoutError` instead of `new Error('LSPS2 request timed out')`.

**Reconciliation (important):** the quote flow already imposes a **7s per-LSP
abort budget** (`context.tsx:runJitQuoteFlow`, verified in
`jit-failover.test.ts:321`), so the 15s reaper will rarely fire during quoting —
the abort wins first. The reaper's real job is bounding **the buy phase**
(`executeJitBuy` ignores abort once `buyChannel` is issued — `context.tsx:333-336`)
and any non-budgeted caller, so a pending promise can never leak. Document this
so the two timeouts aren't seen as duplicative.

### `ChannelConfigOverrides` on 0-conf accept (additive, not a global move)

At `event-handler.ts:618-623`, pass an explicit `ChannelConfigOverrides`
(now constructible: `ChannelConfigOverrides.constructor_new` +
`ChannelConfigUpdate.set_accept_underpaying_htlcs` exist in 0.2.4) that pins the
JIT channel's requirements at accept time:
- `accept_underpaying_htlcs = true`
- inbound in-flight = 100%

**Keep the wallet-global settings (`user-config.ts:26,41`) unchanged** as the
safety net. Rationale: the learnings doc
`docs/solutions/integration-issues/lsps2-jit-receive-channel-config.md` states
the global setting is load-bearing (forwarded HTLCs are silently rejected
without it) and that per-channel overrides were unsupported pre-0.2. This change
makes the JIT channel's config **explicit** without betting the receive flow on
a behavior we haven't validated in production. A full global→per-channel move is
a separate, individually-validated follow-up (out of scope; note in the doc).

## Technical Considerations

- **Wire format is untouched.** Only TypeScript identifiers change; JSON-RPC
  method strings (`lsps2.get_info`, `lsps2.buy`), field names, feature bit 729,
  and message type 37913 stay byte-for-byte identical.
- **Promise model retained.** No change to `context.tsx` orchestration logic —
  only call-site renames (`getOpeningFeeParams` → `requestOpeningParams`, etc.).
- **`createJitInvoice` move:** invoice building (`create_inbound_payment` +
  `encodeBolt11Invoice` with the LSP route hint) moves from `client.ts:99-135`
  into the app layer (`executeJitBuy`, `context.tsx:390-402`, which already calls
  `create_inbound_payment` right before it). The client returns
  `LSPS2InvoiceParameters` (scid + cltv); the caller assembles the BOLT11. The
  BOLT11 result-matching gotcha
  (`Result_Bolt11InvoiceSignOrCreationErrorZ_OK`) from
  `docs/solutions/integration-issues/bip321-unified-uri-bolt11-invoice-generation.md`
  must be preserved.

## System-Wide Impact

- **Interaction graph:** `Receive.tsx` → `runJitQuoteFlow` → `getJitQuote`
  (`requestOpeningParams` → menu select) → `executeJitBuy` (`selectOpeningParams`
  → `create_inbound_payment` → build BOLT11). Payer pays → LSP opens 0-conf
  channel → `Event_OpenChannelRequest` → `accept_inbound_channel_from_trusted_peer_0conf`
  (now with overrides) → `Event_PaymentClaimable`. Renames touch the first chain;
  overrides touch the accept step.
- **Error propagation:** transport errors (`Lsps2*`) bubble from
  `message-handler` → `client` → `getJitQuote`/`executeJitBuy` →
  `runJitQuoteFlow`. Quote path: non-abort → fallback (unchanged). Buy path:
  surfaced to user, **no** failover (unchanged; buy is not failover-eligible).
- **State lifecycle risks:** `executeJitBuy` intentionally runs to completion
  after `buyChannel` to avoid orphaning an LSP reservation. Moving invoice
  construction must keep `create_inbound_payment` and the BOLT11 build inside
  that same non-abortable region so a committed buy always yields a redeemable
  invoice.
- **API surface parity:** the only external consumers of the client are
  `context.tsx` (`getJitQuote`, `executeJitBuy`) and `init.ts` wiring
  (`:669-674,832`). No other call sites.
- **Integration scenarios (must hand-verify):** (1) happy-path LQwD receive
  end-to-end; (2) LQwD peer-connect fail → Megalith fallback still classified
  correctly with typed errors; (3) buy-phase LSP silence → `Lsps2TimeoutError`
  at 15s, user sees a clear failure (no orphaned pending promise); (4) 0-conf
  accept with overrides still opens the channel and forwards the HTLC.

## Implementation Phases

### Phase 1 — Type + error scaffolding (no behavior change)
- Add `src/ldk/lsps2/errors.ts` (typed hierarchy above).
- Rename `OpeningFeeParams` → `LSPS2OpeningFeeParams`, `BuyResponse` →
  `LSPS2InvoiceParameters` in `types.ts` + all imports (`client.ts`,
  `context.tsx`, `jit-failover.test.ts`, `bolt11-encoder.ts`). Keep raw
  serializers and bLIP-52 validation intact.
- Files: `src/ldk/lsps2/errors.ts` (new), `src/ldk/lsps2/types.ts`,
  `src/ldk/lsps2/client.ts`, `src/ldk/context.tsx`, `src/ldk/lsp/jit-failover.test.ts`.

### Phase 2 — Method parity + typed timeouts
- Rename `getOpeningFeeParams` → `requestOpeningParams`, `buyChannel` →
  `selectOpeningParams` (signature order to mirror LDK); update call sites in
  `context.tsx:282,366`.
- `message-handler.ts`: `REQUEST_TIMEOUT_MS` 30_000 → 15_000; replace the four
  `new Error(...)` with `Lsps2TimeoutError` / `Lsps2PeerDisconnectedError` /
  `Lsps2HandlerDestroyedError` / `Lsps2BackpressureError`.
- Files: `src/ldk/lsps2/client.ts`, `src/ldk/lsps2/message-handler.ts`,
  `src/ldk/context.tsx`.

### Phase 3 — Move invoice construction to app layer
- Delete `createJitInvoice` from `client.ts`; `selectOpeningParams` returns
  `LSPS2InvoiceParameters`. Move the route-hint BOLT11 assembly into
  `executeJitBuy` (`context.tsx`), reusing `encodeBolt11Invoice` +
  `parseLsps2Scid` directly.
- Files: `src/ldk/lsps2/client.ts`, `src/ldk/context.tsx`,
  `src/ldk/lsps2/bolt11-encoder.ts` (unchanged; now imported by context).

### Phase 4 — Explicit `ChannelConfigOverrides` on 0-conf accept
- `event-handler.ts:618-623`: construct `ChannelConfigOverrides` pinning
  `accept_underpaying_htlcs=true` + inbound in-flight 100%; pass as the 4th arg.
  Keep global config as safety net.
- Extend the event-handler test to assert the override is passed (mirrors the
  trust-set test pattern from
  `docs/solutions/integration-issues/ldk-event-handler-multi-lsp-trust-set.md`).
- Files: `src/ldk/traits/event-handler.ts`, its test.

## Acceptance Criteria

- [x] Client exposes `requestOpeningParams` / `selectOpeningParams`; no
      `getOpeningFeeParams` / `buyChannel` / `createJitInvoice` remain.
- [x] Types renamed to `LSPS2OpeningFeeParams` / `LSPS2InvoiceParameters`; wire
      serialization + bLIP-52 unknown-field rejection unchanged.
- [x] Transport errors are typed (`Lsps2*`); reaper rejects with
      `Lsps2TimeoutError`; `REQUEST_TIMEOUT_MS === 15_000`.
- [x] Timeout/disconnect errors remain failover-eligible on the quote path and
      non-failover on the buy path (verified by test).
- [x] Invoice construction lives in `executeJitBuy`; client no longer builds
      BOLT11.
- [x] 0-conf accept passes an explicit `ChannelConfigOverrides`; global
      `user-config.ts` settings unchanged.
- [x] `jit-failover.test.ts` and `user-config.test.ts` pass with only mechanical
      renames; event-handler test asserts the override arg.
- [x] No change to JSON-RPC wire format, feature bit 729, or message type 37913.
- [ ] Manual end-to-end: real LQwD JIT receive succeeds; buy-phase silence
      surfaces `Lsps2TimeoutError` at 15s with no leaked pending promise.
      _(Deferred to post-deploy validation — requires a live LSP + running app.)_

## Success Metrics

- Zero behavioral regressions (happy path + all failover scenarios unchanged).
- A future swap to a real `LSPS2ClientHandler` reduces to re-wiring call sites,
  not rewriting logic.
- Incident logs can distinguish timeout vs disconnect vs backpressure.

## Dependencies & Risks

- **Risk: `ChannelConfigOverrides` behavior in WASM unverified in prod.**
  Mitigation: additive (global config retained); Phase 4 is independently
  revertable and separately testable. A full global→per-channel move is out of
  scope.
- **Risk: invoice-construction move alters the non-abortable buy region.**
  Mitigation: keep `create_inbound_payment` + BOLT11 build contiguous inside
  `executeJitBuy`'s post-`buyChannel` section; preserve the
  `Result_Bolt11InvoiceSignOrCreationErrorZ_OK` matching pattern.
- **Risk: rename churn breaks imports/tests.** Mitigation: Phase 1 is pure
  rename; run typecheck + full suite before Phase 2.
- **Constraint carried from brainstorm/memory:** no speculative quote pre-warm
  (`feedback_no_jit_quote_prewarm`); Lightning-first; LQwD primary / Megalith
  fallback unchanged.

## Alternatives Considered (from brainstorm)

- **B — Event-model parity:** rebuild client + `context.tsx` failover around
  LDK's event-driven model. Rejected: large speculative refactor for an upstream
  that may never land in WASM.
- **C — Adapter interface seam:** define an LDK-shaped TS interface with a second
  impl later. Rejected: speculative generality; abstraction for a nonexistent
  second implementation.
- **Pursue upstream bindings:** get `lightning-liquidity` into `ldk-c-bindings`.
  Rejected for now: large, mostly-Rust, out-of-repo, long timeline. Tracked as a
  possible future path.

## Sources & References

### Origin
- **Brainstorm:** [docs/brainstorms/2026-07-06-lsps2-client-ldk-api-parity-brainstorm.md](../brainstorms/2026-07-06-lsps2-client-ldk-api-parity-brainstorm.md).
  Carried-forward decisions: Approach A (naming+type parity, keep promise
  internals); adopt LDK's exact type names; 15s failover-eligible timeout;
  include the `config_overrides` fix; move invoice construction to app layer.

### Internal references
- `src/ldk/lsps2/client.ts` — client methods to rename (`:30,56,99`).
- `src/ldk/lsps2/message-handler.ts:36-69` — existing reaper/timeout to tune;
  `:65,80,158,213` — `new Error` sites to type.
- `src/ldk/lsps2/types.ts:31-46,150-203` — types + wire serializers + bLIP-52 gate.
- `src/ldk/context.tsx:235-409` — `getJitQuote` / `executeJitBuy` call sites +
  7s per-LSP budget; `:390-402` invoice build target.
- `src/ldk/traits/event-handler.ts:608-641` — 0-conf accept + `null` override.
- `src/ldk/user-config.ts:26,41` — global JIT config (retain).
- `src/ldk/lsp/jit-failover.test.ts` — failover contract (must stay green).
- `docs/solutions/integration-issues/lsps2-jit-receive-channel-config.md` —
  global config is load-bearing; per-channel was unsupported pre-0.2.
- `docs/solutions/integration-issues/ldk-event-handler-multi-lsp-trust-set.md` —
  trust-set predicate + test-through-real-handler pattern.
- `docs/solutions/integration-issues/bip321-unified-uri-bolt11-invoice-generation.md` —
  WASM BOLT11 result-matching gotcha.

### External references
- `LSPS2ClientHandler` API — https://docs.rs/lightning-liquidity/latest/lightning_liquidity/lsps2/client/struct.LSPS2ClientHandler.html
- `LSPS2ClientEvent` fields — https://docs.rs/lightning-liquidity/latest/lightning_liquidity/lsps2/event/enum.LSPS2ClientEvent.html
- `ldk-c-bindings` crate list (proof of missing wrap) —
  https://github.com/lightningdevkit/ldk-c-bindings/blob/main/genbindings.sh
