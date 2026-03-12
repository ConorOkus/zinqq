import { Network } from 'lightningdevkit'

export const SIGNET_CONFIG = {
  network: Network.LDKNetwork_Signet,
  esploraUrl: 'https://mutinynet.com/api',
  genesisBlockHash: '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6',
  chainPollIntervalMs: 30_000,
  networkGraphPersistIntervalTicks: 10,
  wsProxyUrl:
    (import.meta.env.VITE_WS_PROXY_URL as string | undefined) ??
    'wss://p.mutinynet.com',
  peerTimerIntervalMs: 10_000,
} as const
