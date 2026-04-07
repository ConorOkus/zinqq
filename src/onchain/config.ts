import { ACTIVE_NETWORK, type NetworkId } from '../ldk/config'

type BdkNetwork = 'bitcoin' | 'signet'

interface OnchainConfig {
  network: BdkNetwork
  esploraUrl: string
  explorerUrl: string
  syncIntervalMs: number
  fullScanGapLimit: number
  syncParallelRequests: number
  esploraMaxRetries: number
}

const ONCHAIN_CONFIGS: Record<NetworkId, OnchainConfig> = {
  signet: {
    network: 'signet',
    esploraUrl: 'https://mutinynet.com/api',
    explorerUrl: 'https://mutinynet.com',
    syncIntervalMs: 180_000,
    fullScanGapLimit: 20,
    syncParallelRequests: 2,
    esploraMaxRetries: 3,
  },
  mainnet: {
    network: 'bitcoin',
    esploraUrl: 'https://mempool.space/api',
    explorerUrl: 'https://mempool.space',
    syncIntervalMs: 180_000,
    fullScanGapLimit: 20,
    syncParallelRequests: 2,
    esploraMaxRetries: 3,
  },
}

const onchainBase = ONCHAIN_CONFIGS[ACTIVE_NETWORK]

export const ONCHAIN_CONFIG: OnchainConfig = {
  ...onchainBase,
  esploraUrl: (import.meta.env.VITE_ESPLORA_URL as string | undefined) ?? onchainBase.esploraUrl,
  explorerUrl: (import.meta.env.VITE_EXPLORER_URL as string | undefined) ?? onchainBase.explorerUrl,
}
