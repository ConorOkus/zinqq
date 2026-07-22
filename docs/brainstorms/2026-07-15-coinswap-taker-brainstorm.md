---
date: 2026-07-15
topic: coinswap-taker
status: postponed
---

# Coinswap Taker Support

## What We Explored

Adding Coinswap taker support to Zinqq via
[coinswap-ffi / coinswap-js](https://github.com/citadel-tech/coinswap-ffi/tree/main/coinswap-js),
so users could break the on-chain history of their UTXOs (general on-chain
privacy, and specifically de-linking funds used for channel opens) — plus
early-ecosystem participation, potentially behind a dev flag.

## Decision: Postpone

Two blocking mismatches surfaced during research:

1. **Runtime mismatch.** Zinqq is a browser-only PWA (WASM packages, no Node,
   no background execution). coinswap-js is a Node.js N-API binding with no
   browser support, and the taker requires a Bitcoin Core full node (RPC +
   txindex + ZMQ) and a Tor daemon. A browser build is not a bindings
   exercise: the upstream taker has no chain-backend abstraction (`Wallet`
   and `WatchService` call Bitcoin Core RPC/ZMQ directly) and depends on
   tokio, `std::thread`, `std::fs`, and raw TCP sockets. A WASM port means a
   significant upstream refactor (backend trait + Esplora impl, no-threads,
   WebSocket/Tor transport — Zinqq's `proxy/` WS→TCP worker is a plausible
   transport bridge, at the cost of the proxy operator seeing swap
   connections).
2. **No counterparties.** The maker marketplace is currently live only on a
   custom Signet. Zinqq is mainnet-only, so there is nobody to swap with even
   with a working port.

Architectures that ship sooner were considered and rejected: a user-hosted
companion daemon (limits the audience to node runners) and a Zinqq-operated
server-side taker (custodial during the swap — conflicts with Zinqq's
self-custody stance).

## Revisit Triggers

Re-open this brainstorm when **either** of these happens:

- The Coinswap maker marketplace goes live on **mainnet**, or
- Upstream ships (or seriously starts) a **browser/WASM-compatible taker**
  (chain-backend abstraction with an Esplora implementation, no
  Bitcoin-Core/ZMQ requirement).

Preferred direction at that point: in-PWA WASM taker (self-custodial),
surfaced under Settings → Advanced, with swap state persisted to survive tab
death (coinswaps are long-running; upstream's `SwapTracker`/`RecoveryLoop`
resumability is a good sign here).

## Key Decisions

- **Postpone; no code now**: runtime mismatch + no mainnet makers means
  nothing shippable exists to build against.
- **No companion daemon / no custodial swap service**: wrong audience or
  wrong custody model for Zinqq.
- **Browser-WASM is the only acceptable end-state**: consistent with the
  LDK/BDK WASM precedent and self-custody stance.

## Resolved Questions

- _Where would the taker run?_ → In the PWA via a future WASM build; all
  server-side variants rejected.
- _What do we invest now?_ → Nothing beyond this document; revisit on the
  triggers above.

## Next Steps

→ None now. On a revisit trigger, restart with `/ce:brainstorm` using this
document as input.
