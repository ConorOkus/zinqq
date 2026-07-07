# Brainstorm: Harden the hand-rolled LSPS2 client toward LDK API parity

**Date:** 2026-07-06
**Status:** Brainstorm — pending open-question resolution
**Origin:** `/ce:brainstorm "switch to using the built in LSPS2Client"`

## Context: why we are not literally switching

The trigger was "switch to using the built-in `LSPS2Client`." Investigation proved that
option does not exist for this app today:

- `lightning-liquidity` (the crate containing `LSPS2ClientHandler` / `LiquidityManager`)
  is **not wrapped by `ldk-c-bindings`** — its `genbindings.sh` wraps only `lightning`,
  `lightning-types`, `lightning-persister`, `lightning-background-processor`,
  `lightning-invoice`, `lightning-rapid-gossip-sync`.
- Therefore the `lightningdevkit` WASM/npm package (generated from those C bindings) ships
  **zero** LSPS/liquidity symbols. Verified on `lightningdevkit@0.2.4-0` (latest): grep of
  `node_modules/lightningdevkit/` finds no `LSPS2*` / `LiquidityManager`; the only "Liquidity"
  symbol is `ChannelLiquidities` (the routing scorer, unrelated).
- The bindings **do** expose every low-level JIT primitive: `CustomMessageHandler`,
  `create_inbound_payment`, `get_intercept_scid` / `forward_intercepted_htlc` /
  `fail_intercepted_htlc`, `accept_inbound_channel_from_trusted_peer_0conf`, and the
  `UserConfig`/`ChannelConfig` knobs (`accept_underpaying_htlcs`, etc.).

So the missing piece is only the **LSPS2 protocol layer** (message types, JSON-RPC framing,
fee-param menu handling, client state machine) — which is exactly what this wallet hand-rolled
in `src/ldk/lsps2/`. The literal switch is blocked upstream; it would require getting
`lightning-liquidity` into the binding generator first (large, mostly-Rust, out-of-repo).

## What We're Building

**Approach A — Naming + type parity (thin veneer).** Keep the hand-rolled client and its
promise-based internals, but reshape its public surface to mirror LDK's `LSPS2ClientHandler`,
and fold in robustness wins that pay off regardless of any future swap:

1. **Method/type parity** — rename to LDK's vocabulary and align types:
   - `getOpeningFeeParams()` → `requestOpeningParams(counterpartyNodeId, token)`
   - `buyChannel()` → `selectOpeningParams(counterpartyNodeId, paymentSizeMsat, openingFeeParams)`
   - align `OpeningFeeParams` / `BuyResponse` field shapes to LDK's `LSPS2OpeningFeeParams`
     and the `InvoiceParametersReady` payload (intercept_scid, cltv_expiry_delta, payment_size).
2. **Robustness (value now):** per-request timeout on the peer round-trip (mobile peers drop),
   a named error taxonomy mapping bLIP-52 error codes, and defensive handling of concurrent /
   orphaned request-ids (already keyed by id + sender pubkey).
3. **Incidental config_overrides fix:** `accept_inbound_channel_from_trusted_peer_0conf` in
   0.2.4 now takes a 4th `config_overrides: ChannelConfigOverrides | null` param; the current
   call at `event-handler.ts:622` passes only 3 args. Consider passing per-channel JIT config
   (e.g. `accept_underpaying_htlcs`) here instead of relying solely on global `UserConfig`.

Explicitly **out of scope:** adopting LDK's event-driven interaction model (Approach B) and
introducing a swap-in adapter interface (Approach C).

## Why This Approach

- **Improves the code whether or not the built-in client ever ships.** B and C spend real
  effort betting on an uncertain upstream event (bindings that may never land, or land with a
  different shape) — speculative generality. A does not.
- **Cheaper future swap as a bonus.** Matching names/types shrinks a future migration to a
  re-wire rather than a rewrite; the remaining structural step (promise → event model) is
  deferred until it is actually justified.
- **Low blast radius.** Keeping promise internals means `context.tsx` quote/buy/failover
  orchestration and `jit-failover.test.ts` stay intact — no rebuild of the LQwD→Megalith
  cascade around an event bus.
- **Respects existing constraints:** no speculative quote pre-warm
  (`feedback_no_jit_quote_prewarm`), Lightning-first, LQwD primary / Megalith fallback.

## Key Decisions

- **Keep the custom client; do not pursue upstream bindings now.** (Tracked as a possible
  future path, not this effort.)
- **Parity is naming + types only.** Promise-based request/response internals are retained.
- **Bundle concrete robustness (timeout, error taxonomy) into the same effort** so the change
  ships user-visible value, not just cosmetics.
- **Move JIT invoice construction to the app layer** — LDK's built-in client does not build the
  invoice itself (handler returns scid + cltv; caller builds it). Mirror that seam now.
- **Adopt LDK's exact type names** (`LSPS2OpeningFeeParams`, `InvoiceParametersReady`, …).
- **Bundle the `config_overrides` fix** into this effort.
- **Request timeout: 15s, failover-eligible.**

## Affected surface (for the eventual plan)

- `src/ldk/lsps2/client.ts` (method/type renames, timeout, errors)
- `src/ldk/lsps2/types.ts` (type-shape alignment, error taxonomy)
- `src/ldk/lsps2/message-handler.ts` (request-id lifecycle / timeout hook)
- `src/ldk/context.tsx` (call-site renames only — no behavioral change)
- `src/ldk/traits/event-handler.ts:622` (config_overrides 4th arg)
- `src/ldk/lsps2/bolt11-encoder.ts`, `node-secret.ts` (unchanged unless invoice scope shifts)

## Open Questions

None — all resolved below.

## Resolved Questions

- **Type-naming style:** adopt LDK's **exact** names (`LSPS2OpeningFeeParams`,
  `InvoiceParametersReady`, etc.) for maximum parity, accepting the larger diff.
- **config_overrides fix scope:** **include** the `event-handler.ts:622` 4-arg change in this
  effort (same subsystem), rather than splitting it out.
- **Request timeout:** **15s, failover-eligible** — fail the peer round-trip after 15s and treat
  it like `JitPeerConnectError`, cascading LQwD→Megalith.
- **`createJitInvoice` placement:** **move invoice construction to the app layer** to mirror LDK
  (handler returns scid + cltv; caller builds the invoice). This supersedes the earlier
  "keep it on the client for now" note in Key Decisions.

- _Is the built-in LSPS2 client available in the WASM bindings?_ — **No** (verified three ways;
  see Context).
- _Is there any other LSP / liquidity management in the bindings?_ — **No high-level LSP/liquidity
  API**; only low-level JIT primitives (see Context).
- _Which direction?_ — **Harden the hand-rolled client (Approach A)**, chosen over upstream
  bindings, event-model parity, and adapter seam.
