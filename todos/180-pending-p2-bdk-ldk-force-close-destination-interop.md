---
status: pending
priority: p2
issue_id: '180'
tags: [recovery, bdk, ldk, fund-safety]
---

# BDK/LDK force-close destination script interop

## Problem

`get_destination_script` in `bdk-signer-provider.ts` must be deterministic from
`channel_keys_id` so that ChannelManager deserialization on a different device
produces the same script. BDK's `revealNextAddress` is non-deterministic and
broke cross-browser VSS recovery, so we reverted to always using KeysManager's
default implementation.

This means force-close funds go to a KeysManager-derived address instead of a
BDK wallet address. The funds are still controlled by the same seed, but they
won't appear in the BDK wallet's on-chain balance.

Cooperative close funds still go to BDK via `get_shutdown_scriptpubkey`.

## Desired outcome

Force-close funds should appear in the BDK wallet balance without breaking
cross-device restore.

## Possible approaches

1. **Derive BDK address deterministically from `channel_keys_id`** — map the
   channel_keys_id to a specific BDK derivation index so the same address is
   produced on any device.
2. **Import KeysManager-derived addresses into BDK** — after LDK init, scan
   for KeysManager destination scripts and add them to BDK's watch list.
3. **Persist a `channel_keys_id → script` mapping in VSS** — store the
   destination script when the channel is created, retrieve it during restore.
4. **Initialize BDK before LDK** — restructure init order so BDK wallet is
   available during ChannelManager deserialization, and use a stable address
   derivation scheme.

## Context

- Fixed in: `bdk-signer-provider.ts` (reverted `get_destination_script` to
  always use KeysManager)
- Related: KeysManager timestamp persistence fix in `init.ts` / `seed.ts`
