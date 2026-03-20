import { Network } from 'lightningdevkit'

export const SIGNET_CONFIG = {
  network: Network.LDKNetwork_Signet,
  esploraUrl: 'https://mutinynet.com/api',
  chainPollIntervalMs: 30_000,
  wsProxyUrl:
    (import.meta.env.VITE_WS_PROXY_URL as string | undefined) ??
    'wss://p.mutinynet.com',
  peerTimerIntervalMs: 10_000,
  rgsUrl: 'https://rgs.mutinynet.com/snapshot',
  rgsSyncIntervalTicks: 60, // ~30 min at 30s chain poll interval
  vssUrl:
    (import.meta.env.VITE_VSS_URL as string | undefined) ??
    (import.meta.env.DEV ? '/__vss_proxy/vss' : 'https://vss.mutinynet.com/vss'),
} as const
