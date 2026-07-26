---
title: 'LDK WASM: LockedChannelMonitor is opaque — per-monitor balance reads are closed off'
category: integration-issues
date: 2026-07-21
tags: [ldk, wasm, bindings, chain-monitor, balances, channel-close, close-records]
modules: [src/ldk/close-records/estimate, src/ldk/close-records/reconcile]
---

# LDK WASM: LockedChannelMonitor is opaque — per-monitor balance reads are closed off

## Problem

The natural API for per-channel balance/timelock data —
`ChainMonitor.get_monitor(channelId)` → `monitor.get_claimable_balances()` — does not
exist in the `lightningdevkit` 0.2.4-0 TS bindings. `Result_LockedChannelMonitorNoneZ_OK.res`
is a `LockedChannelMonitor` that exposes **only `free()`**: no balance reads, no
`get_funding_txo`, no `check_and_update_full_resolution_status`. Plans written against
docs.rs (where these methods exist on the Rust type) silently hit a wall.

## Root Cause

The WASM bindings generate `LockedChannelMonitor` as a bare lock handle; none of
`ChannelMonitor`'s read methods are projected onto it. `ChainMonitor.get_claimable_balances(ignored_channels)`
IS available, but returns a **flat `Balance[]` with no channel attribution**.

## Solution

Two workarounds, both shipped in the close-transparency feature:

1. **Single-channel attribution via ignored-channels filtering** (`src/ldk/close-records/estimate.ts`,
   `readOnCloseBalance`): call `chainMonitor.get_claimable_balances(allChannelsExceptTarget)`
   and trust the result **only when exactly one** `Balance_ClaimableOnChannelClose` entry
   remains — ambiguity (≥2 entries, e.g. another channel mid-close) degrades to
   "unavailable" rather than misattributing.
2. **Capture channel facts while the channel is open** — `to_self_delay`
   (`get_force_close_spend_delay()`) and the funding outpoint are readable from
   `ChannelDetails` only until the channel closes. The close-records feature captures both
   at `Event_ChannelPending` into a persisted safety-net map (`src/ldk/close-records/store.ts`,
   `FundingTxoEntry`), then derives timelock expiry itself
   (`claimableAtHeight = close confirm height + timelockBlocks`) instead of asking the monitor.

For completion evidence, lean on **BDK wallet receipt** (funds confirmed in our own
wallet) rather than monitor resolution status.

## Prevention

Before planning around any LDK API, verify it against the **installed** `.d.mts`
declarations (`node_modules/lightningdevkit/structs/`), not docs.rs — the bindings lag and
prune. Re-check `LockedChannelMonitor` on every LDK bindings upgrade; if it gains read
methods, `estimate.ts`/`reconcile.ts` can drop the filtering workaround (both carry
comments pointing here).
