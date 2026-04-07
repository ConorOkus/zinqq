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
    lspNodeId: '0275eb44504d53b2a083852e3bffcc4e178195b9546c162590d8c282f3ed3243fc',
    lspHost: '192.243.215.98',
    lspPort: 25000,
    genesisBlockHash: '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6',
  },
  mainnet: {
    network: Network.LDKNetwork_Bitcoin,
    esploraUrl: 'https://mempool.space/api',
    esploraFallbackUrl: 'https://blockstream.info/api',
    chainPollIntervalMs: 60_000,
    wsProxyUrl: 'wss://proxy.zinqq.app',
    peerTimerIntervalMs: 10_000,
    rgsUrl: 'https://rapidsync.lightningdevkit.org/snapshot',
    rgsSyncIntervalTicks: 30,
    vssUrl: '/api/vss-proxy',
    lspNodeId: '038a9e56512ec98da2b5789761f7af8f280baf98a09282360cd6ff1381b5e889bf',
    lspHost: '64.23.162.51',
    lspPort: 9735,
    genesisBlockHash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
  },
}

const networkId = (import.meta.env.VITE_NETWORK ?? 'signet') as string
if (!(networkId in NETWORK_CONFIGS)) {
  throw new Error(`[Config] Invalid VITE_NETWORK="${networkId}". Must be "mainnet" or "signet".`)
}

const base = NETWORK_CONFIGS[networkId as NetworkId]

export const LDK_CONFIG: LdkConfig = {
  ...base,
  wsProxyUrl: (import.meta.env.VITE_WS_PROXY_URL as string | undefined) ?? base.wsProxyUrl,
  vssUrl: (import.meta.env.VITE_VSS_URL as string | undefined) ?? base.vssUrl,
  lspNodeId: (import.meta.env.VITE_LSP_NODE_ID as string | undefined) ?? base.lspNodeId,
  lspHost: (import.meta.env.VITE_LSP_HOST as string | undefined) ?? base.lspHost,
  lspPort: Number(import.meta.env.VITE_LSP_PORT ?? base.lspPort),
  lspToken: (import.meta.env.VITE_LSP_TOKEN as string | undefined) ?? base.lspToken,
}

if (!LDK_CONFIG.wsProxyUrl) {
  throw new Error(
    `[LDK Config] wsProxyUrl is empty for ${networkId}. ` +
      'Set VITE_WS_PROXY_URL to the WebSocket proxy endpoint.'
  )
}

export const ACTIVE_NETWORK: NetworkId = networkId as NetworkId
