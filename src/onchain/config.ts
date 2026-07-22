// Compile-time safety limits (bigint, not env-overridable). Kept as top-level
// exports rather than inside ONCHAIN_CONFIG because that object holds
// runtime/env-derived values; these are invariants of the wallet's fee policy.

/** Minimum fee rate the wallet will broadcast at (sat/vB). */
export const MIN_FEE_RATE_SAT_VB = 2n

/** Sanity ceiling for absolute fee on any on-chain send (sats). */
export const MAX_FEE_SATS = 50_000n

/**
 * Reserve UTXOs for anchor channel CPFP fee bumping. When the user has open
 * Lightning channels, the on-chain wallet must retain enough sats to fund a
 * child transaction if a force-close requires fee bumping. 10,000 sats covers
 * a ~150 vB CPFP at ~50 sat/vB.
 */
export const ANCHOR_RESERVE_SATS = 10_000n

interface OnchainConfig {
  network: 'bitcoin'
  esploraUrl: string
  explorerUrl: string
  syncIntervalMs: number
  fullScanGapLimit: number
  syncParallelRequests: number
  esploraMaxRetries: number
}

const DEFAULTS: OnchainConfig = {
  network: 'bitcoin',
  esploraUrl: '/api/esplora',
  explorerUrl: 'https://mempool.space',
  syncIntervalMs: 180_000,
  fullScanGapLimit: 20,
  syncParallelRequests: 2,
  esploraMaxRetries: 3,
}

/** BDK's WASM reqwest client cannot resolve relative URLs — resolve against page origin. */
function resolveUrl(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  return `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`
}

export const ONCHAIN_CONFIG: OnchainConfig = {
  ...DEFAULTS,
  esploraUrl: resolveUrl(
    (import.meta.env.VITE_ESPLORA_URL as string | undefined) ?? DEFAULTS.esploraUrl
  ),
  explorerUrl: (import.meta.env.VITE_EXPLORER_URL as string | undefined) ?? DEFAULTS.explorerUrl,
}
