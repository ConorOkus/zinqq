---
title: 'feat: Mainnet infrastructure config (Esplora, RGS, VSS, network switching)'
type: feat
status: active
date: 2026-03-30
origin: docs/brainstorms/2026-03-30-mainnet-infra-brainstorm.md
---

# feat: Mainnet infrastructure config (Esplora, RGS, VSS, network switching)

## Overview

Replace the hardcoded `SIGNET_CONFIG` / `ONCHAIN_CONFIG` with a network-keyed config map selected by a build-time `VITE_NETWORK` env var. Add mainnet service URLs, deploy as separate Vercel projects, and add safety rails to prevent cross-network misconfiguration.

## Problem Statement / Motivation

Zinqq is hardcoded to signet/mutinynet. To ship a mainnet product, the app needs:

- Mainnet Esplora, RGS, and VSS endpoints
- Correct LDK/BDK network enums for mainnet
- Megalith LSP wired to mainnet config (it only supports mainnet)
- Safety checks to prevent deploying mainnet code against signet infra (or vice versa)

(see brainstorm: `docs/brainstorms/2026-03-30-mainnet-infra-brainstorm.md`)

## Proposed Solution

### Phase 1: Unified config map with build-time network selection

Replace `SIGNET_CONFIG` and `ONCHAIN_CONFIG` with a single `NetworkConfig` type and a `NETWORK_CONFIGS` map. A build-time assertion on `VITE_NETWORK` selects the active config. All consumers import `LDK_CONFIG` and `ONCHAIN_CONFIG` (now network-aware).

**`src/ldk/config.ts`:**

```typescript
import { Network } from 'lightningdevkit'

type NetworkId = 'mainnet' | 'signet'

interface LdkConfig {
  network: Network
  esploraUrl: string
  esploraFallbackUrl?: string
  chainPollIntervalMs: number
  wsProxyUrl: string
  peerTimerIntervalMs: number
  rgsUrl: string
  rgsSyncIntervalTicks: number
  vssUrl: string
  lspNodeId: string
  lspHost: string
  lspPort: number
  lspToken?: string
  genesisBlockHash: string
}

const NETWORK_CONFIGS: Record<NetworkId, LdkConfig> = {
  signet: {
    network: Network.LDKNetwork_Signet,
    esploraUrl: 'https://mutinynet.com/api',
    chainPollIntervalMs: 30_000,
    wsProxyUrl: 'wss://p.mutinynet.com',
    peerTimerIntervalMs: 10_000,
    rgsUrl: 'https://rgs.mutinynet.com/snapshot',
    rgsSyncIntervalTicks: 60,
    vssUrl: '/api/vss-proxy',
    lspNodeId: '', // No signet-compatible LSP currently
    lspHost: '',
    lspPort: 9736,
    genesisBlockHash: '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6',
  },
  mainnet: {
    network: Network.LDKNetwork_Bitcoin,
    esploraUrl: 'https://mempool.space/api',
    esploraFallbackUrl: 'https://blockstream.info/api',
    chainPollIntervalMs: 30_000,
    wsProxyUrl: '', // Set via VITE_WS_PROXY_URL in Vercel
    peerTimerIntervalMs: 10_000,
    rgsUrl: 'https://rapidsync.lightningdevkit.org/snapshot',
    rgsSyncIntervalTicks: 60,
    vssUrl: '/api/vss-proxy',
    lspNodeId: '034066e29e402d9cf55af1ae1026cc5adf92eed1e0e421785442f53717ad1453b0',
    lspHost: '64.23.159.177',
    lspPort: 9735,
    genesisBlockHash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
  },
}

const networkId = (import.meta.env.VITE_NETWORK ?? 'signet') as string
if (!(networkId in NETWORK_CONFIGS)) {
  throw new Error(`[Config] Invalid VITE_NETWORK="${networkId}". Must be "mainnet" or "signet".`)
}

// Apply env var overrides (same pattern as current SIGNET_CONFIG)
const base = NETWORK_CONFIGS[networkId as NetworkId]
export const LDK_CONFIG: LdkConfig = {
  ...base,
  wsProxyUrl: (import.meta.env.VITE_WS_PROXY_URL as string | undefined) ?? base.wsProxyUrl,
  vssUrl: (import.meta.env.VITE_VSS_URL as string | undefined) ?? base.vssUrl,
  lspNodeId: (import.meta.env.VITE_LSP_NODE_ID as string | undefined) ?? base.lspNodeId,
  lspHost: (import.meta.env.VITE_LSP_HOST as string | undefined) ?? base.lspHost,
  lspPort: Number(import.meta.env.VITE_LSP_PORT ?? base.lspPort),
  lspToken: import.meta.env.VITE_LSP_TOKEN as string | undefined,
}

export const ACTIVE_NETWORK: NetworkId = networkId as NetworkId
```

**`src/onchain/config.ts`:**

```typescript
import { ACTIVE_NETWORK } from '../ldk/config'

type BdkNetwork = 'bitcoin' | 'signet'
const BDK_NETWORK_MAP: Record<string, BdkNetwork> = { mainnet: 'bitcoin', signet: 'signet' }

interface OnchainConfig {
  network: BdkNetwork
  esploraUrl: string
  explorerUrl: string
  syncIntervalMs: number
  fullScanGapLimit: number
  syncParallelRequests: number
  esploraMaxRetries: number
}

const ONCHAIN_CONFIGS: Record<string, OnchainConfig> = {
  signet: {
    network: 'signet',
    esploraUrl: 'https://mutinynet.com/api',
    explorerUrl: 'https://mutinynet.com',
    syncIntervalMs: 80_000,
    fullScanGapLimit: 20,
    syncParallelRequests: 5,
    esploraMaxRetries: 3,
  },
  mainnet: {
    network: 'bitcoin',
    esploraUrl: 'https://mempool.space/api',
    explorerUrl: 'https://mempool.space',
    syncIntervalMs: 80_000,
    fullScanGapLimit: 20,
    syncParallelRequests: 5,
    esploraMaxRetries: 3,
  },
}

export const ONCHAIN_CONFIG: OnchainConfig = ONCHAIN_CONFIGS[ACTIVE_NETWORK]
```

### Phase 2: Rename all SIGNET_CONFIG imports

Mechanical find-and-replace across ~8 files:

- `src/ldk/init.ts` — `SIGNET_CONFIG` → `LDK_CONFIG`
- `src/ldk/context.tsx` — `SIGNET_CONFIG` → `LDK_CONFIG`
- `src/ldk/peers/peer-connection.ts` — `SIGNET_CONFIG` → `LDK_CONFIG`
- `src/pages/Restore.tsx` — `SIGNET_CONFIG` → `LDK_CONFIG`
- `src/pages/OpenChannel.tsx` — `SIGNET_CONFIG` → `LDK_CONFIG`
- `src/ldk/config.test.ts` — update test to cover both network configs
- `src/ldk/init-recovery.test.ts` — update mock

### Phase 3: Safety rails

#### 3a. Genesis block hash verification at init

Add to `doInitializeLdk()` after fetching the chain tip — before creating the ChannelManager:

```typescript
// Verify Esplora serves the expected network
const genesisHash = await esplora.getBlockHash(0)
if (genesisHash !== LDK_CONFIG.genesisBlockHash) {
  throw new Error(
    `[LDK Init] Network mismatch: Esplora returned genesis ${genesisHash.substring(0, 16)}... ` +
      `but expected ${LDK_CONFIG.genesisBlockHash.substring(0, 16)}... for ${ACTIVE_NETWORK}`
  )
}
```

This is the last line of defense against deploying with wrong env vars.

#### 3b. Network-tagged IDB database name

In `src/storage/idb.ts`, change:

```typescript
import { ACTIVE_NETWORK } from '../ldk/config'
export const DB_NAME = `zinqq-ldk-${ACTIVE_NETWORK}`
```

This prevents same-origin IDB collisions when a developer runs both networks on localhost. Also prevents cross-network channel state contamination.

#### 3c. LSP graceful degradation

When `lspNodeId` is empty (signet with no LSP):

- Skip auto-connect to LSP peer at init (`context.tsx:728`)
- Hide "Receive via Lightning (new channel)" in the UI when no LSP is configured
- `requestJitInvoice` returns an error: "Lightning receive requires an LSP. Currently unavailable on this network."

#### 3d. Network badge in UI

Add a small persistent badge showing "SIGNET" or "TESTNET" when not on mainnet. Mainnet shows nothing (clean UI). This prevents users from confusing test funds with real funds.

### Phase 4: Esplora fallback (LDK-side only)

The BDK WASM `EsploraClient` takes a single URL at construction and cannot be swapped at runtime. Fallback is limited to LDK consumers:

- `src/ldk/sync/esplora-client.ts` — retry with fallback URL on 5xx or network error
- `src/ldk/traits/fee-estimator.ts` — retry with fallback URL
- `src/ldk/traits/broadcaster.ts` — retry with fallback URL (critical for fund safety)
- `src/ldk/traits/event-handler.ts` — retry with fallback URL for sweep broadcasts

Pattern: try primary → on 5xx/timeout/network error → retry once with `esploraFallbackUrl`. No circuit breaker needed at current scale. BDK uses `mempool.space` only (no fallback).

### Phase 5: Deployment

#### Vercel projects

| Project       | Domain            | `VITE_NETWORK` | `VSS_ORIGIN`   | `VITE_WS_PROXY_URL`     |
| ------------- | ----------------- | -------------- | -------------- | ----------------------- |
| zinqq-mainnet | zinqq.com         | `mainnet`      | mainnet VSS IP | production WS proxy URL |
| zinqq-testnet | testnet.zinqq.com | `signet`       | signet VSS IP  | dev WS proxy URL        |

Both deploy from the same repo. Vercel env vars control the network.

#### WebSocket proxy

Update `proxy/wrangler.toml` production `ALLOWED_ORIGINS`:

```toml
[env.production.vars]
ALLOWED_ORIGINS = "https://zinqq.com,https://testnet.zinqq.com"
ALLOWED_PORTS = "9735,9736"
```

Single shared proxy worker for both networks (simpler ops, Lightning ports are the same).

#### Preview deployments

Preview deployments default to signet (the `VITE_NETWORK` default). Dev WS proxy `ALLOWED_ORIGINS` already includes `*.vercel.app`.

### Phase 6: Fee limit review

Move fee safety constants into the per-network config:

| Constant         | Signet    | Mainnet                                      |
| ---------------- | --------- | -------------------------------------------- |
| `MAX_FEE_SATS`   | `50_000n` | `50_000n` (keep for now, ~$50 cap)           |
| `MAX_FEE_SAT_KW` | `500_000` | `500_000` (keep, matches mainnet fee spikes) |

These are reasonable for mainnet. Can be adjusted later based on user feedback.

## Technical Considerations

- **LDK vs BDK network types:** LDK uses `Network.LDKNetwork_Bitcoin` (enum), BDK uses `'bitcoin'` (string). The config map handles this mapping. No cross-validation needed since both derive from the same `ACTIVE_NETWORK` key.
- **BOLT 12 offer chain:** `builder.chain(LDK_CONFIG.network)` will automatically use the correct network. Network-tagged IDB prevents cross-contamination.
- **RGS timestamp persistence:** `ldk_rgs_last_sync_timestamp` is in IDB, which is now network-tagged. No cross-network RGS delta issues.
- **Rate limits:** mempool.space and blockstream.info public APIs handle the 30s/80s polling intervals without issue.
- **VSS store isolation:** Separate VSS server instances per network. Even if the same mnemonic produces the same `vssStoreId`, requests go to different servers.
- **Known Vercel gotcha:** VSS proxy must use Node.js runtime (not Edge) if VSS is on a private IP. Already handled by current implementation (see `docs/solutions/infrastructure/vercel-staging-vss-serverless-proxy.md`).

## Acceptance Criteria

- [x] `VITE_NETWORK=mainnet` build produces a working app connected to mainnet Esplora, RGS, and VSS
- [x] `VITE_NETWORK=signet` build produces a working app identical to current behavior (minus Megalith LSP)
- [x] Invalid `VITE_NETWORK` value throws at build time (module evaluation)
- [x] Genesis block hash mismatch throws at init time
- [x] IDB databases are isolated per network (`zinqq-ldk-mainnet` vs `zinqq-ldk-signet`)
- [ ] Esplora fallback to blockstream.info works when mempool.space returns 5xx (LDK consumers)
- [x] LSP-dependent UI is hidden when no LSP is configured (signet)
- [x] Network badge shows "SIGNET" on testnet deployments, nothing on mainnet
- [x] WS proxy accepts connections from both `zinqq.com` and `testnet.zinqq.com`
- [x] All existing tests pass with `VITE_NETWORK=signet`
- [x] Config test covers both network entries

## Dependencies & Risks

- **Megalith LSP availability:** If Megalith is down or requires a token, mainnet JIT receive won't work. Risk is acceptable — on-chain receive still works.
- **Public Esplora reliability:** mempool.space is battle-tested but not SLA-backed. Fallback to blockstream.info mitigates this.
- **RGS availability:** LDK/Spiral RGS is the canonical instance. If down, gossip sync stalls but existing routes still work.
- **VSS mainnet instance:** Needs to be provisioned and running before mainnet deployment. This is a prerequisite.

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-30-mainnet-infra-brainstorm.md](docs/brainstorms/2026-03-30-mainnet-infra-brainstorm.md) — Key decisions: public Esplora/RGS instances, separate VSS, build-time env var switching, Megalith for mainnet.

### Internal References

- Current LDK config: `src/ldk/config.ts:1-20`
- Current onchain config: `src/onchain/config.ts:1-9`
- IDB database name: `src/storage/idb.ts`
- VSS proxy serverless function: `api/vss-proxy.ts`
- WS proxy config: `proxy/wrangler.toml`
- Past solution (VSS proxy): `docs/solutions/infrastructure/vercel-staging-vss-serverless-proxy.md`
- Past solution (WS proxy): `docs/solutions/infrastructure/websocket-tcp-proxy-cloudflare-workers.md`
