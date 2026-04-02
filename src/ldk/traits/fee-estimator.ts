import { FeeEstimator, ConfirmationTarget } from 'lightningdevkit'
import { captureError } from '../../storage/error-log'

// Default fee rates in sat/KW (1 sat/vB = 250 sat/KW)
const DEFAULT_FEE_RATES: Record<ConfirmationTarget, number> = {
  [ConfirmationTarget.LDKConfirmationTarget_MaximumFeeEstimate]: 50_000,
  [ConfirmationTarget.LDKConfirmationTarget_UrgentOnChainSweep]: 25_000,
  [ConfirmationTarget.LDKConfirmationTarget_MinAllowedAnchorChannelRemoteFee]: 2_500,
  [ConfirmationTarget.LDKConfirmationTarget_MinAllowedNonAnchorChannelRemoteFee]: 2_500,
  [ConfirmationTarget.LDKConfirmationTarget_AnchorChannelFee]: 2_500,
  [ConfirmationTarget.LDKConfirmationTarget_NonAnchorChannelFee]: 5_000,
  [ConfirmationTarget.LDKConfirmationTarget_ChannelCloseMinimum]: 1_000,
  [ConfirmationTarget.LDKConfirmationTarget_OutputSpendingFee]: 5_000,
}

interface FeeCache {
  rates: Map<number, number>
  fetchedAt: number
}

const CACHE_TTL_MS = 60_000 // 1 minute
const MAX_FEE_SAT_KW = 500_000 // ~2,000 sat/vB — beyond this, something is wrong

export function createFeeEstimator(esploraUrl: string): FeeEstimator {
  let cache: FeeCache | null = null

  function refreshCache(): void {
    fetch(`${esploraUrl}/fee-estimates`)
      .then((res) => {
        if (!res.ok) throw new Error(`Fee API responded with ${res.status.toString()}`)
        return res.json() as Promise<Record<string, number>>
      })
      .then((estimates) => {
        const rates = new Map<number, number>()
        for (const [blocks, feePerVbyte] of Object.entries(estimates)) {
          if (
            typeof feePerVbyte !== 'number' ||
            !Number.isFinite(feePerVbyte) ||
            feePerVbyte <= 0
          ) {
            continue
          }
          // Esplora returns sat/vB, LDK wants sat/KW (multiply by 250)
          const satKw = Math.round(feePerVbyte * 250)
          rates.set(Number(blocks), Math.min(satKw, MAX_FEE_SAT_KW))
        }
        cache = { rates, fetchedAt: Date.now() }
      })
      .catch((err: unknown) => {
        captureError(
          'warning',
          'LDK FeeEstimator',
          'Failed to fetch fee estimates, using defaults',
          String(err)
        )
      })
  }

  // Fetch immediately on creation
  refreshCache()

  function getCachedFeeRate(confirmationTarget: ConfirmationTarget): number {
    // Refresh if stale
    if (!cache || Date.now() - cache.fetchedAt > CACHE_TTL_MS) {
      refreshCache()
    }

    if (!cache || cache.rates.size === 0) {
      return DEFAULT_FEE_RATES[confirmationTarget] ?? 5_000
    }

    // Map confirmation targets to block confirmation counts
    let targetBlocks: number
    switch (confirmationTarget) {
      case ConfirmationTarget.LDKConfirmationTarget_MaximumFeeEstimate:
      case ConfirmationTarget.LDKConfirmationTarget_UrgentOnChainSweep:
        targetBlocks = 1
        break
      case ConfirmationTarget.LDKConfirmationTarget_AnchorChannelFee:
      case ConfirmationTarget.LDKConfirmationTarget_NonAnchorChannelFee:
        targetBlocks = 6
        break
      case ConfirmationTarget.LDKConfirmationTarget_ChannelCloseMinimum:
      case ConfirmationTarget.LDKConfirmationTarget_OutputSpendingFee:
        targetBlocks = 12
        break
      case ConfirmationTarget.LDKConfirmationTarget_MinAllowedAnchorChannelRemoteFee:
      case ConfirmationTarget.LDKConfirmationTarget_MinAllowedNonAnchorChannelRemoteFee:
        targetBlocks = 144
        break
      default:
        targetBlocks = 6
    }

    // Direct lookup, fallback to default
    const feeRate = cache.rates.get(targetBlocks)
    // LDK enforces minimum of 253 sat/KW (1 sat/vB)
    return Math.max(feeRate ?? DEFAULT_FEE_RATES[confirmationTarget] ?? 5_000, 253)
  }

  return FeeEstimator.new_impl({
    get_est_sat_per_1000_weight(confirmation_target: ConfirmationTarget): number {
      return getCachedFeeRate(confirmation_target)
    },
  })
}
