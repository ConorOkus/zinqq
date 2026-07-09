---
title: "LDK's built-in LSPS2 client (lightning-liquidity) is not in the WASM bindings — hand-roll the protocol layer"
category: integration-issues
date: 2026-07-07
severity: HIGH
module: src/ldk/lsps2/, node_modules/lightningdevkit
tags:
  - ldk
  - lsps2
  - lightning-liquidity
  - LSPS2ClientHandler
  - wasm-bindings
  - ldk-c-bindings
  - jit-channels
related:
  - lsps2-jit-receive-channel-config.md
  - ldk-event-handler-multi-lsp-trust-set.md
related_pr: 167
origin:
  - docs/brainstorms/2026-07-06-lsps2-client-ldk-api-parity-brainstorm.md
  - docs/plans/2026-07-06-002-refactor-lsps2-client-ldk-api-parity-plan.md
commit: eba6504
---

# LDK's built-in LSPS2 client is not available in the WASM bindings

## Problem

You want to "just use LDK's built-in LSPS2 client" (`LSPS2ClientHandler` /
`LiquidityManager` from the `lightning-liquidity` crate) instead of hand-rolling
the JIT-channel protocol. It is **not importable** from the `lightningdevkit`
JS/WASM package — there is no `LSPS2*` or `LiquidityManager` symbol to call.

## Root cause

The `lightningdevkit` npm/WASM package is generated from `ldk-c-bindings` (via
the C bindings → `ldk-garbagecollected` pipeline). Its `genbindings.sh` wraps
only these crates: `lightning`, `lightning-types`, `lightning-persister`,
`lightning-background-processor`, `lightning-invoice`,
`lightning-rapid-gossip-sync`. **`lightning-liquidity` is not wrapped**, so its
client/service types never reach the C bindings and therefore never reach WASM.
`lightning-liquidity` is Rust-only today (consumable from `ldk-node` /
LDK Server, not from the TS/WASM bindings). Verified on `lightningdevkit@0.2.4-0`
(latest as of 2026-07).

## How to verify (three ways)

```bash
# 1. Latest published version — no separate liquidity package exists
npm view lightningdevkit version           # → 0.2.4-0

# 2. The installed bindings expose ZERO LSPS/liquidity symbols
#    (only "Liquidity" hit is ChannelLiquidities — the routing scorer, unrelated)
ls node_modules/lightningdevkit/structs/ | grep -iE "lsps|liquidity"
grep -rilE "LSPS2ClientHandler|LiquidityManager" node_modules/lightningdevkit/

# 3. Upstream generator does not wrap the crate
#    https://github.com/lightningdevkit/ldk-c-bindings/blob/main/genbindings.sh
#    → add_crate lines list lightning, lightning-types, lightning-persister,
#      lightning-background-processor, lightning-invoice,
#      lightning-rapid-gossip-sync — NOT lightning-liquidity
```

## Solution

Hand-roll the LSPS2 **protocol layer** on top of the low-level JIT primitives the
bindings _do_ expose. The WASM package includes everything needed to act as an
LSPS2 client except the protocol/state-machine itself:

- Transport: `CustomMessageHandler` / `CustomMessageReader` (BOLT8 custom
  messages, feature bit `729`, message type `37913`).
- Inbound payments: `ChannelManager.create_inbound_payment[_for_hash]`.
- HTLC interception: `get_intercept_scid`, `forward_intercepted_htlc`,
  `fail_intercepted_htlc`, `accept_intercept_htlcs`, `HTLCIntercepted` event.
- 0-conf accept: `accept_inbound_channel_from_trusted_peer_0conf` (0.2 added a
  4th `ChannelConfigOverrides` slot).
- Knobs: `accept_underpaying_htlcs`, `max_inbound_htlc_value_in_flight_percent_of_channel`.
- Invoice: `Bolt11Invoice`, `RouteHint`, `RouteHintHop`.

This wallet's implementation lives in `src/ldk/lsps2/` — `client.ts`
(get*info/buy JSON-RPC), `message-handler.ts` (sync↔async bridge over
`CustomMessageHandler`), `types.ts` (bLIP-52 serialization + fee math),
`bolt11-encoder.ts` (route-hint invoice). Its public surface deliberately mirrors
`LSPS2ClientHandler` (`requestOpeningParams`, `selectOpeningParams`) so a future
swap — \_if* `lightning-liquidity` ever lands in the bindings — is a re-wire, not a
rewrite. The remaining structural gap is the async model: LDK's handler is
event-driven (`OpeningParametersReady` / `InvoiceParametersReady`), whereas the
hand-rolled client is promise-based.

## Prevention

Before proposing "use the built-in LDK X" for any `lightning-*` crate from the
JS/WASM (or Swift/Kotlin) app, first check whether that crate is wrapped by
`ldk-c-bindings/genbindings.sh`. If it is not in the `add_crate` list, it is not
reachable from the bindings, no matter how mature the Rust API is — scope the work
as a hand-rolled layer (or an upstream bindings contribution), not an import.
