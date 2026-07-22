---
title: 'LSPS2 JIT Receive: Channel Config Required for Payment Claiming'
category: integration-issues
date: 2026-03-31
tags: [lsps2, ldk, jit-channel, htlc, channel-config, lightning]
severity: high
components: [ldk/init.ts, ldk/traits/event-handler.ts, src/pages/Receive.tsx]
---

# LSPS2 JIT Receive: Channel Config Required for Payment Claiming

## Problem

LSPS2 JIT channel flow appeared to work — the channel opened successfully via 0-conf — but inbound payments were silently rejected. No `PendingHTLCsForwardable`, `PaymentClaimable`, or `PaymentClaimed` events ever fired after `ChannelReady`. The LSP reported it forwarded the HTLC, but LDK never acknowledged it.

## Root Cause

Two missing LDK `UserConfig` settings caused LDK to silently reject the forwarded HTLC:

1. **`max_inbound_htlc_value_in_flight_percent_of_channel` defaulted to 10%.** On a 13,500 sat JIT channel, this capped the max inbound HTLC at ~1,350 sats. The LSP's `channel_update` confirmed this: `htlc_maximum_msat: 1350000`. A 9,000 sat HTLC (10,000 minus 1,000 opening fee) exceeded this limit and was rejected before generating any events.

2. **`accept_underpaying_htlcs` defaulted to false.** The LSP deducts an opening fee before forwarding, so the HTLC amount (9,000 sats) is less than the invoice amount (10,000 sats). Without this flag, LDK rejects the HTLC as underpaying.

These are the same two settings that [ldk-node applies for LSPS2 clients](https://github.com/lightningdevkit/ldk-node/blob/3aef2b39/src/event.rs#L1268-L1286).

## Solution

Add both settings to `createUserConfig()` in `src/ldk/init.ts`:

```typescript
// Allow full channel capacity for inbound HTLCs (default 10% is too
// restrictive for JIT channels where the payment ≈ channel size)
handshakeConfig.set_max_inbound_htlc_value_in_flight_percent_of_channel(100)

// LSP deducts opening fee before forwarding — allow claiming
// these underpaying HTLCs (fee validated at invoice creation time)
const channelConfig = config.get_channel_config()
channelConfig.set_accept_underpaying_htlcs(true)
```

Note (pre-0.2, historical): The LDK WASM bindings don't support per-channel config overrides on `accept_inbound_channel_from_trusted_peer_0conf` (it takes 3 args, not 4). These settings must be applied globally. This is safe because the `OpenChannelRequest` handler only accepts channels from a trusted LSP (see [`ldk-event-handler-multi-lsp-trust-set.md`](ldk-event-handler-multi-lsp-trust-set.md) for the trust-set mechanism).

**2026-07 update:** LDK 0.2 added the 4th `config_overrides` parameter to `accept_inbound_channel_from_trusted_peer_0conf`. The two settings above are now enforced BOTH globally (`user-config.ts`, retained as a safety net) AND per-channel via `buildJitChannelConfigOverrides()` (`src/ldk/traits/event-handler.ts` ~121-139, called at ~774-778), with `src/ldk/jit-channel-config.ts` as the single source of truth for the values.

## Debugging Approach

The key diagnostic was the `channel_update` message logged after `ChannelReady`:

```
htlc_maximum_msat: 1350000
```

This revealed the 10% default was capping the HTLC size. Without this log, the failure was completely silent — no events, no errors, no LDK internal log messages about the rejection.

## Prevention

- When implementing LSPS2 with raw LDK (not ldk-node), always check what config ldk-node applies for the same flow. ldk-node handles many edge cases that aren't documented in the LSPS2 spec itself.
- Add `Event_HTLCHandlingFailed` to the event handler — it fires when LDK rejects an HTLC, providing diagnostic information that would otherwise be invisible.
- Log the `channel_update` messages received from peers, as they reveal the negotiated channel parameters.

## Related

- [ldk-node LSPS2 channel config](https://github.com/lightningdevkit/ldk-node/blob/3aef2b39/src/event.rs#L1268-L1286)
- PR #71: fix: complete LSPS2 JIT receive flow and improve balance updates
