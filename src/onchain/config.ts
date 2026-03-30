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
