---
title: 'LQwD JIT channel opens rejected by announcement preference and non-anchor feerate floor'
category: 'integration-issues'
date: 2026-05-09
tags:
  - ldk
  - lsps2
  - lqwd
  - channel-handshake
  - anchor-channels
  - fee-estimator
  - mainnet
severity: 'critical'
components:
  - 'src/ldk/user-config.ts'
  - 'src/ldk/traits/fee-estimator.ts'
  - 'src/ldk/traits/event-handler.ts'
symptoms:
  - 'Got non-closing error: Peer tried to open channel but their announcement preference is different from ours'
  - 'OpenChannelRequest: failed to accept 0-conf from LSP'
  - "Got non-closing error: Peer's feerate much too low. Actual: 253. Our expected lower limit: 2500"
---

# LQwD JIT channel opens rejected by announcement preference and non-anchor feerate floor

## Problem

After PR #148 (2026-05-06) made LQwD the primary LSPS2 LSP, all inbound JIT channels failed to open. Users tapping "Request" saw the invoice appear but any incoming payment stalled — the LSP attempted to open the JIT channel, LDK rejected the open, and no funds arrived. The wallet-level error log only surfaced the generic message from `src/ldk/traits/event-handler.ts:647`:

```
OpenChannelRequest: failed to accept 0-conf from LSP
```

The actual rejection reasons came from LDK's `channelmanager` line emitted _above_ the wallet log, which made the failure easy to misdiagnose as an LSPS2/invoice issue rather than a channel-handshake config mismatch. The two verbatim LDK errors were:

```
Peer tried to open channel but their announcement preference is different from ours
Peer's feerate much too low. Actual: 253. Our expected lower limit: 2500
```

Both fire _inside_ `accept_inbound_channel_from_trusted_peer_0conf`, so the `result.is_ok()` branch at `event-handler.ts:640` returned false with no context attached.

## Root Cause

### 1. Announcement preference mismatch

LDK's `ChannelHandshakeLimits.force_announced_channel_preference` defaults to `true`: any open whose `announce_for_forwarding` flag differs from ours is rejected. Our config sets `announce_for_forwarding=false` (private channel); LQwD proposes a different value, so LDK aborts the handshake before the trusted-peer 0-conf path can succeed.

### 2. Non-anchor feerate floor

LDK enforces `MinAllowedNonAnchorChannelRemoteFee` from the fee estimator during open. PR #102 lowered only the _anchor_ floor to 253 sat/kW; the non-anchor floor remained at the default 2,500. LQwD doesn't negotiate `option_anchors_zero_fee_htlc_tx`, so its commitment-tx fee proposal of 253 sat/kW (1 sat/vB) failed the non-anchor check.

## Solution

**`src/ldk/user-config.ts`** — disable the announce-preference gate:

```ts
const handshakeLimits = config.get_channel_handshake_limits()
handshakeLimits.set_trust_own_funding_0conf(true)

// LDK rejects opens whose announce flag differs from our default
// (`announce_for_forwarding=false`) with "announcement preference is
// different from ours". LQwD diverges; turn the check off.
handshakeLimits.set_force_announced_channel_preference(false)
```

**`src/ldk/traits/fee-estimator.ts:17-20`** — lower the non-anchor remote-fee floor to LDK's absolute minimum:

```ts
// LDK absolute minimum (1 sat/vB). Trusted LSPS2 LSPs that don't negotiate
// `option_anchors_zero_fee_htlc_tx` (LQwD as of 2026-05) propose ~253 sat/kW
// commitment fees that would otherwise be rejected at channel open.
[ConfirmationTarget.LDKConfirmationTarget_MinAllowedNonAnchorChannelRemoteFee]: 253,
```

The refactor extracted `createUserConfig` from `init.ts` into its own module so it could be unit-tested without the full init dependency chain. 7 regression tests landed in `user-config.test.ts` (covering each handshake setter) and 2 in `fee-estimator.test.ts` (asserting the 253 sat/kW floors).

Both relaxations are safe because they only take effect _after_ the trust gate at `src/ldk/traits/event-handler.ts:625-655`. The handshake config is global, but the path that consumes it — `accept_inbound_channel_from_trusted_peer_0conf` — is only invoked when `isTrustedLsp(counterpartyHex)` returns true (line 629). Unknown peers hit the `else` branch at line 649 and timeout silently, so the loosened announce-flag and feerate checks never apply to untrusted opens.

## Key Insight

LSP-specific config workarounds belong in a per-LSP capability layer, not a global `UserConfig`. Every relaxation accepted globally is debt: today it's two flips for LQwD; adding a 3rd LSP could push the config to the loosest-common-denominator across all of them, weakening every trust boundary the wallet relies on. The long-term fix — a per-LSP capability matrix that derives the handshake config per-counterparty from `isTrustedLsp` metadata — is tracked as todo #362.

## Prevention

- **Setter-level config tests pin every UserConfig knob (`src/ldk/user-config.test.ts`).** Seven unit tests now assert each setter is called with the exact value LSPS2 + LQwD require: `set_manually_accept_inbound_channels(true)`, `set_negotiate_scid_privacy(true)`, `set_negotiate_anchors_zero_fee_htlc_tx(true)`, `set_max_inbound_htlc_value_in_flight_percent_of_channel(100)`, `set_trust_own_funding_0conf(true)`, **`set_force_announced_channel_preference(false)` (the LQwD regression guard)**, and `set_accept_underpaying_htlcs(true)`. A silent regression (e.g. someone re-defaulting `force_announced_channel_preference`) now fails CI instead of producing an init log that looks identical to the working build.

- **Feerate-floor regression pins at 253 sat/kW (`src/ldk/traits/fee-estimator.test.ts`).** Two new cases lock both `MinAllowedAnchorChannelRemoteFee` and `MinAllowedNonAnchorChannelRemoteFee` to LDK's 1 sat/vB absolute minimum when esplora returns nothing. Bumping either floor above 253 — the exact value LQwD opens with — re-introduces "Peer's feerate much too low" and now fails locally before review.

- **Observability gap (todo #358, open).** The `OpenChannelRequest` accept path logs the LSP node id but not the LSP's `channel_flags`, anchor advertisement, or proposed commitment feerate — the three inputs that decided accept/reject. **Lesson: when a config relaxation accepts a wider set of inputs, log which input you actually got, or you cannot detect drift.** Diagnosis required reading the channelmanager line above the wallet-level "failed to accept 0-conf from LSP" message; that adjacency is fragile and should be replaced with one structured log line on the accept path.

- **Per-LSP capability layer (todo #362, open).** Don't push global `UserConfig` to the loosest common denominator as the trust set grows. Each new trusted LSP should be onboarded with an explicit capability declaration — `{ anchors, announce_flag, min_commitment_feerate_sat_kw }` — checked against the incoming `OpenChannelRequest`, instead of a one-line "we observed this LSP rejects opens; relax the global check" that silently widens acceptance for every future peer.

- **Docs are load-bearing — name the LSP (todo #363).** The earlier `ldk-anchor-channel-feerate-floor-fix.md` asserted `MinAllowedNonAnchorChannelRemoteFee correctly remains at 2500` — true for Megalith, false for LQwD. Solutions docs documenting an LSP-specific tradeoff must name the LSP, and the doc must be linked from the LSP onboarding playbook so it is re-reviewed at every swap.

- **Runbook addition — LSP swap checklist.** Before merging a primary-LSP swap: (1) force a real channel open on staging against the new LSP and capture the `OpenChannel` message; (2) diff `channel_flags`, anchor support, and proposed commitment feerate against the outgoing LSP; (3) update the per-LSP capability table and any solutions doc that names the previous LSP; (4) only then flip the primary.

## Related

### Prior solutions in this codebase

- [`anchor-channels-lsp-compatibility.md`](anchor-channels-lsp-compatibility.md) — Fix mainnet LSP anchor channel rejections due to disabled anchor negotiation (enabled `anchors_zero_fee_htlc_tx` for Megalith).
- [`ldk-anchor-channel-feerate-floor-fix.md`](ldk-anchor-channel-feerate-floor-fix.md) — Lowered `MinAllowedAnchorChannelRemoteFee` to 253 sat/kW so Megalith's anchor `open_channel` feerate passed LDK's `check_remote_fee`. **Note: this doc is now stale — see todo #363.**
- [`lsps2-lqwd-primary-unreachable-proxy-and-duplicate-connect.md`](lsps2-lqwd-primary-unreachable-proxy-and-duplicate-connect.md) — Same-origin proxy port 26000 allowlist + dedup of duplicate `connectPeer` calls so LQwD becomes reachable as the primary LSPS2 provider.
- [`ldk-event-handler-multi-lsp-trust-set.md`](ldk-event-handler-multi-lsp-trust-set.md) — LSPS2 trusted-LSP gate was hardcoded to the fallback pubkey and rejected primary LQwD 0-conf channels; fixed by switching to a `trustedLspIds` set.
- [`lqwd-lsp-cors-vercel-vite-proxy.md`](lqwd-lsp-cors-vercel-vite-proxy.md) — LQwD LSP discovery blocked by browser CORS; fixed via same-origin Vercel/Vite proxy at `/api/lqwd-proxy`.
- [`lsps2-jit-receive-channel-config.md`](lsps2-jit-receive-channel-config.md) — Per-channel `ChannelConfig` (trust-0-conf, fee overrides) required for LSPS2 JIT HTLC claim to succeed.

### Pull requests in the LSP-config evolution

- PR #82 — disable anchor channels (LSP compatibility testing era)
- PR #100 — re-enable anchor channels for Megalith
- PR #102 — lower `MinAllowedAnchorChannelRemoteFee` to 253
- PR #148 — promote LQwD to primary, Megalith to fallback
- PR #154 — fix LQwD proxy port 26000 allowlist
- PR #162 — _this fix_ (relax announce-pref + non-anchor feerate floor for LQwD)

### Follow-up todos (open)

- #357 (P2) — Pin LQwD pubkey (or allowlist) before adding to `trustedLspIds`
- #358 (P2) — Log channel features (anchors, announce flag) and negotiated feerate at `OpenChannelRequest` accept
- #359 (P2) — Non-anchor channels accepted from LQwD have no CPFP fee-bump path on force-close (user warning needed)
- #361 (P3) — Extract `LDK_ABSOLUTE_MIN_SAT_KW = 253` constant in `fee-estimator.ts`
- #362 (P3) — Per-LSP capability matrix on `LspContact` (instead of relaxing global `UserConfig`)
- #363 (P3) — Update or supersede `ldk-anchor-channel-feerate-floor-fix.md` (now stale)
- #364 (P3) — Upstream: ask LQwD to negotiate `option_anchors_zero_fee_htlc_tx`
