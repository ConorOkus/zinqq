import { Network } from 'lightningdevkit'

export type NetworkId = 'mainnet' | 'signet'

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

// Note: vssUrl uses a relative path (/api/vss-proxy) that requires a proxy:
// - Dev: Vite's server.proxy config (vite.config.ts)
// - Production: Vercel rewrite rules (vercel.json)
// - pnpm preview: NOT supported — Vite's preview server doesn't run proxy config
const NETWORK_CONFIGS: Record<NetworkId, LdkConfig> = {
  signet: {
    network: Network.LDKNetwork_Signet,
    esploraUrl: 'https://mutinynet.com/api',
    chainPollIntervalMs: 60_000,
    wsProxyUrl: 'wss://p.mutinynet.com',
    peerTimerIntervalMs: 10_000,
    rgsUrl: 'https://rgs.mutinynet.com/snapshot',
    rgsSyncIntervalTicks: 30,
    vssUrl: '/api/vss-proxy',
    lspNodeId: '',
    lspHost: '',
    lspPort: 9735,
    genesisBlockHash: '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6',
  },
  mainnet: {
    network: Network.LDKNetwork_Bitcoin,
    esploraUrl: '/api/esplora',
    esploraFallbackUrl: 'https://mempool.space/api',
    chainPollIntervalMs: 60_000,
    wsProxyUrl: 'wss://proxy.zinqq.app',
    peerTimerIntervalMs: 10_000,
    rgsUrl: 'https://rapidsync.lightningdevkit.org/snapshot',
    rgsSyncIntervalTicks: 30,
    vssUrl: '/api/vss-proxy',
    lspNodeId: '',
    lspHost: '',
    lspPort: 9735,
    genesisBlockHash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
  },
}

const networkId = ((import.meta.env.VITE_NETWORK ?? 'signet') as string).trim()
if (!(networkId in NETWORK_CONFIGS)) {
  throw new Error(`[Config] Invalid VITE_NETWORK="${networkId}". Must be "mainnet" or "signet".`)
}

const base = NETWORK_CONFIGS[networkId as NetworkId]

export const LDK_CONFIG: LdkConfig = {
  ...base,
  esploraUrl: ((import.meta.env.VITE_ESPLORA_URL as string | undefined) ?? base.esploraUrl).trim(),
  wsProxyUrl: ((import.meta.env.VITE_WS_PROXY_URL as string | undefined) ?? base.wsProxyUrl).trim(),
  vssUrl: ((import.meta.env.VITE_VSS_URL as string | undefined) ?? base.vssUrl).trim(),
  lspNodeId: ((import.meta.env.VITE_LSP_NODE_ID as string | undefined) ?? base.lspNodeId).trim(),
  lspHost: ((import.meta.env.VITE_LSP_HOST as string | undefined) ?? base.lspHost).trim(),
  lspPort: Number(
    ((import.meta.env.VITE_LSP_PORT as string | undefined) ?? String(base.lspPort)).trim()
  ),
  lspToken: ((import.meta.env.VITE_LSP_TOKEN as string | undefined) ?? base.lspToken)?.trim(),
}

if (!LDK_CONFIG.wsProxyUrl) {
  throw new Error(
    `[LDK Config] wsProxyUrl is empty for ${networkId}. ` +
      'Set VITE_WS_PROXY_URL to the WebSocket proxy endpoint.'
  )
}

// Validate LSP config. Empty lspNodeId disables LSPS2 (valid for testing).
if (LDK_CONFIG.lspNodeId !== '') {
  if (!/^[0-9a-f]{66}$/.test(LDK_CONFIG.lspNodeId)) {
    throw new Error(
      `[LDK Config] Invalid lspNodeId "${LDK_CONFIG.lspNodeId.substring(0, 20)}...". ` +
        'Must be a 66-character lowercase hex public key, or empty to disable LSPS2.'
    )
  }
  if (
    !Number.isFinite(LDK_CONFIG.lspPort) ||
    LDK_CONFIG.lspPort < 1 ||
    LDK_CONFIG.lspPort > 65535
  ) {
    throw new Error(`[LDK Config] Invalid lspPort "${LDK_CONFIG.lspPort}". Must be 1-65535.`)
  }
  if (!LDK_CONFIG.lspHost) {
    throw new Error(
      '[LDK Config] lspHost is empty but lspNodeId is set. Both are required for LSPS2.'
    )
  }
}

export const ACTIVE_NETWORK: NetworkId = networkId as NetworkId
