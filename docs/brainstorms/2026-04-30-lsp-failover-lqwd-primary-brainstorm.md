---
date: 2026-04-30
topic: lsp-failover-lqwd-primary
---

# LSP Failover — LQwD Germany Primary, Megalith Fallback

## What We're Building

A primary/fallback model for LSPS2 JIT channels. Default to **LQwD
Germany** (`https://germany.lqwd.tech`); fall back transparently to
the existing **Megalith** integration when LQwD can't serve the
request. No user-visible LSP picker, no new product surface — receive
flow looks identical from the user's seat. Telemetry only.

Bottom of the cascade is unchanged: if both LSPs fail, the receive
flow degrades to on-chain-only address (same as today's behavior at
`src/pages/Receive.tsx:144-150`).

## Why This Approach

The codebase already ships a battle-tested fallback pattern at
`src/ldk/traits/broadcaster.ts:36-62` (`broadcastWithRetry`: primary
Esplora → fallback mempool.space, with separate retry budgets and
"Primary exhausted, trying fallback" logging). LSP failover mirrors
that pattern at the LSPS2 layer, which keeps the mental model
consistent and the implementation small.

Scope is deliberately narrow: **LSPS2 only**, same flow we have today
(see brainstorm phase 0 — LSPS1 paid channels were considered and
deferred to a separate plan if/when there's product demand). LQwD's
HTTP `/get_info` is treated as a discovery + liveness endpoint;
everything else (fee menu, payment-size limits) still flows over LN
p2p via LSPS2 JSON-RPC, exactly as Megalith does today.

## Key Decisions

- **Primary**: LQwD Germany. Pubkey/host/port read from
  `https://germany.lqwd.tech/api/v1/get_info` `uris[0]` field on each
  app boot; cached for the session. Single source of truth — handles
  pubkey/IP rotation without redeploys.
- **Fallback**: Megalith. Stays env-var driven
  (`VITE_LSP_NODE_ID/HOST/PORT/TOKEN` in `src/ldk/config.ts:50-56`).
  No config changes for the fallback path.
- **Fallback triggers** (any of these on the primary attempt routes
  to Megalith for the same receive call):
  1. Pre-flight HTTP `GET /get_info` 5xx, network error, or timeout.
  2. Peer connect to LQwD's pubkey fails.
  3. LSPS2 RPC fails or times out (`getOpeningFeeParams`,
     `buyChannel`).
  4. User's payment amount falls outside LQwD's `min_payment_size_msat`
     / `max_payment_size_msat` from the LSPS2 fee menu (Megalith may
     accept a different range).
- **No mid-flow swapping**: Once `buyChannel` succeeds and we've
  committed to an LSP for a given invoice, we do not switch. The
  invoice contains that LSP's route hint and its commitment.
- **Bottom of cascade**: If both LSPs fail, receive flow degrades to
  on-chain only (existing behavior). No new error surface.
- **User visibility**: None. Silent automatic fallback. Mirrors
  `broadcastWithRetry`. Selected-LSP + fallback-reason + timing
  captured in telemetry (Sentry) for observability.
- **CSP**: Add `https://germany.lqwd.tech` to `connect-src` in both
  `vercel.json:31` and `index.html:13` (HTTP `/get_info` fetch
  requires it). LSP node-level p2p still flows through
  `wss://proxy.zinqq.app` — already covered.
- **Update reference memory** post-merge:
  `~/.claude/projects/.../memory/reference_megalith_lsp.md` becomes
  reference for the _fallback_ LSP, with a new entry pointing at LQwD
  as primary.

## Resolved Questions

1. **Scope**: LSPS2 only. LSPS1 paid channels deferred (no product
   demand today; new transport + new UI would be multi-day work).
2. **Fallback triggers**: All four (HTTP pre-flight, peer connect,
   LSPS2 RPC, payment-size).
3. **Discovery**: HTTP `/get_info` on each boot, session-cached.
4. **Visibility**: Silent + telemetry only. No UI surface.

## Open Questions

None. Ready for `/ce:plan`.

## Next Steps

→ `/ce:plan` for the implementation details. Plan should cover:

- `/get_info` fetch + parse + session cache (new module)
- CSP entry additions
- Generalize current `connectAndTrack` + LSPS2 JSON-RPC path to
  accept a primary/fallback pair
- Telemetry buckets (selected_lsp, fallback_reason)
- Test matrix: LQwD-down, LQwD-up-RPC-fails, payment-size out-of-range,
  both-down → on-chain only
- Pattern reference: `src/ldk/traits/broadcaster.ts:36-62`
