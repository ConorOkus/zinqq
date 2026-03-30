# Brainstorm: Mainnet Infrastructure (Esplora, RGS, VSS)

**Date:** 2026-03-30
**Status:** Complete

## What We're Building

Mainnet-ready infrastructure configuration so Zinqq can deploy to Bitcoin mainnet alongside the existing signet/mutinynet deployment. This covers three backend services (Esplora, RGS, VSS), network-aware config, and the deployment model.

## Why This Approach

The goal is the simplest solution that scales: **separate Vercel deployments** with a **build-time `VITE_NETWORK` env var** that selects the correct config. No runtime network switching, no conditional logic in components. Each deployment is fully isolated.

## Key Decisions

### 1. Esplora: mempool.space (primary) + blockstream.info (fallback)

Public instances, no self-hosting. Both are reliable, well-maintained, and free for the traffic levels Zinqq generates. Fallback provides resilience if one goes down.

- **Mainnet primary:** `https://mempool.space/api`
- **Mainnet fallback:** `https://blockstream.info/api`

### 2. RGS: LDK/Spiral (primary) + Mutiny (fallback)

Official LDK RGS server maintained by Spiral. Well-tested, used by most LDK wallets. Mutiny's RGS as fallback.

- **Mainnet primary:** `https://rapidsync.lightningdevkit.org/snapshot`
- **Mainnet fallback:** `https://rgs.mutinynet.com/snapshot` (if they run a mainnet instance)

### 3. VSS: Separate mainnet instance

Dedicated VSS server for mainnet, fully isolated from the signet VSS. This prevents any cross-contamination of channel state between networks.

### 4. Network switching: Build-time env var + separate Vercel deployments

A single `VITE_NETWORK=mainnet|signet` env var selects the config object at build time. Two Vercel projects deploy from the same repo:

- `zinqq.com` — mainnet (`VITE_NETWORK=mainnet`)
- `testnet.zinqq.com` — signet (`VITE_NETWORK=signet`)

Each project has its own env vars (VSS_ORIGIN, LSP config, WS proxy URL, etc.). Adding a new network is just a new Vercel project.

### 5. LSP: Megalith for mainnet

The Megalith LSP node (`03e30f...`) is already hardcoded in the signet config but only supports mainnet. It moves to `MAINNET_CONFIG` where it belongs. Signet gets a test LSP or no LSP.

### 6. Config architecture

Replace the single `SIGNET_CONFIG` export with a network-keyed config map:

```
NETWORK_CONFIGS = { signet: {...}, mainnet: {...} }
export const CONFIG = NETWORK_CONFIGS[VITE_NETWORK]
```

All existing code that imports `SIGNET_CONFIG` switches to importing `CONFIG`. Same for `ONCHAIN_CONFIG`.

## Resolved Questions

- **Hosting model?** Public instances for Esplora and RGS, self-hosted VSS only.
- **Network switching?** Build-time env var, not runtime toggle.
- **LSP?** Megalith for mainnet. Signet LSP TBD (or disabled).
- **VSS isolation?** Separate instance per network.

## Open Questions

None — ready for planning.
