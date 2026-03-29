import { Network } from 'lightningdevkit'

export const SIGNET_CONFIG = {
  network: Network.LDKNetwork_Signet,
  esploraUrl: 'https://mutinynet.com/api',
  chainPollIntervalMs: 30_000,
  wsProxyUrl: (import.meta.env.VITE_WS_PROXY_URL as string | undefined) ?? 'wss://p.mutinynet.com',
  peerTimerIntervalMs: 10_000,
  rgsUrl: 'https://rgs.mutinynet.com/snapshot',
  rgsSyncIntervalTicks: 60, // ~30 min at 30s chain poll interval
  // The default path requires a proxy (Vite dev server or Vercel rewrite); pnpm preview won't proxy it.
  vssUrl: (import.meta.env.VITE_VSS_URL as string | undefined) ?? '/api/vss-proxy',
  // TODO: Replace with a mutinynet-compatible LSP — Megalith only supports mainnet
  lspNodeId:
    (import.meta.env.VITE_LSP_NODE_ID as string | undefined) ??
    '03e30fda71887a916ef5548a4d02b06fe04aaa1a8de9e24134ce7f139cf79d7579',
  lspHost: (import.meta.env.VITE_LSP_HOST as string | undefined) ?? '64.23.192.68',
  lspPort: Number(import.meta.env.VITE_LSP_PORT ?? '9736'),
  lspToken: import.meta.env.VITE_LSP_TOKEN as string | undefined,
} as const
