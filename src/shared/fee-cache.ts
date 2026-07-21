import { captureError } from '../storage/error-log'

const CACHE_TTL_MS = 60_000

// Fallback rates (sat/vB) used when esplora hasn't responded yet.
// The 1-block default was lowered from 25 to 10 so that anchor CPFP fee
// bumps can succeed with ~10k sats in the wallet at startup, before the
// first esplora fee-estimates fetch completes. Once esplora responds the
// real rate takes over. 10 sat/vB is high enough to confirm within a few
// blocks under normal mempool conditions; if actual fees spike higher,
// the esplora rate will drive the estimate.
const DEFAULT_RATES: Record<number, number> = { 1: 10, 6: 5, 12: 3, 144: 2 }

interface FeeCache {
  rates: Record<string, number> // block-target → sat/vB (raw esplora format)
  fetchedAt: number
}

const FAILURE_BACKOFF_MS = 15_000

// Callers (e.g. the sweep) hold in-progress guards across this fetch; a hung
// request must reject instead of pinning them forever. Matches esplora-client.ts.
const FETCH_TIMEOUT_MS = 10_000

let cache: FeeCache | null = null
let pendingFetch: Promise<void> | null = null
let esploraBaseUrl: string | null = null
let lastFailedAt = 0

/**
 * Initialise the fee cache with the esplora URL. Must be called once at
 * startup before any reads. Triggers an immediate background fetch.
 */
export function initFeeCache(esploraUrl: string): void {
  esploraBaseUrl = esploraUrl
  void refreshFeeCache()
}

/**
 * Fire-and-forget cache refresh. Deduplicates concurrent calls — only one
 * fetch can be in-flight at a time.
 */
function refreshFeeCache(): Promise<void> | null {
  if (pendingFetch) return pendingFetch
  if (!esploraBaseUrl) return null
  if (Date.now() - lastFailedAt < FAILURE_BACKOFF_MS) return null

  pendingFetch = fetch(`${esploraBaseUrl}/fee-estimates`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`Fee API responded with ${res.status.toString()}`)
      return res.json() as Promise<Record<string, number>>
    })
    .then((estimates) => {
      const rates: Record<string, number> = {}
      for (const [blocks, feePerVbyte] of Object.entries(estimates)) {
        if (typeof feePerVbyte === 'number' && Number.isFinite(feePerVbyte) && feePerVbyte > 0) {
          rates[blocks] = feePerVbyte
        }
      }
      cache = { rates, fetchedAt: Date.now() }
    })
    .catch((err: unknown) => {
      lastFailedAt = Date.now()
      captureError(
        'warning',
        'FeeCache',
        'Failed to fetch fee estimates, using defaults',
        String(err)
      )
    })
    .finally(() => {
      pendingFetch = null
    })

  return pendingFetch
}

function isCacheStale(): boolean {
  return !cache || Date.now() - cache.fetchedAt > CACHE_TTL_MS
}

function defaultRate(target: number): number {
  return DEFAULT_RATES[target] ?? DEFAULT_RATES[6] ?? 1
}

/**
 * Synchronous read — returns cached sat/vB for the given block target, or
 * the default if no cache exists. Triggers a background
 * refresh when the cache is stale.
 *
 * Used by the LDK FeeEstimator trait (synchronous callback).
 */
export function getCachedFeeRate(target: number): number {
  if (isCacheStale()) void refreshFeeCache()
  if (!cache) return defaultRate(target)
  return cache.rates[String(target)] ?? defaultRate(target)
}

/**
 * Async read — returns sat/vB for the given block target. If the cache is
 * stale, awaits the in-flight fetch (or triggers one) before returning.
 * Falls back to defaults on failure.
 *
 * Used by UI components and async operations (sweep, send, open channel).
 */
export async function getFeeRate(target: number): Promise<number> {
  if (isCacheStale()) {
    const pending = refreshFeeCache()
    if (pending) await pending
  }
  return cache?.rates[String(target)] ?? defaultRate(target)
}
