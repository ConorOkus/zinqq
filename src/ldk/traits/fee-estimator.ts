import { FeeEstimator, ConfirmationTarget } from 'lightningdevkit'
import { getCachedFeeRate } from '../../shared/fee-cache'

// Default fee rates in sat/KW (1 sat/vB = 250 sat/KW)
const DEFAULT_FEE_RATES: Record<ConfirmationTarget, number> = {
  [ConfirmationTarget.LDKConfirmationTarget_MaximumFeeEstimate]: 50_000,
  [ConfirmationTarget.LDKConfirmationTarget_UrgentOnChainSweep]: 25_000,
  [ConfirmationTarget.LDKConfirmationTarget_MinAllowedAnchorChannelRemoteFee]: 253,
  [ConfirmationTarget.LDKConfirmationTarget_MinAllowedNonAnchorChannelRemoteFee]: 2_500,
  [ConfirmationTarget.LDKConfirmationTarget_AnchorChannelFee]: 2_500,
  [ConfirmationTarget.LDKConfirmationTarget_NonAnchorChannelFee]: 5_000,
  [ConfirmationTarget.LDKConfirmationTarget_ChannelCloseMinimum]: 1_000,
  [ConfirmationTarget.LDKConfirmationTarget_OutputSpendingFee]: 5_000,
}

const MAX_FEE_SAT_KW = 500_000 // ~2,000 sat/vB — beyond this, something is wrong

function targetToBlocks(confirmationTarget: ConfirmationTarget): number {
  switch (confirmationTarget) {
    case ConfirmationTarget.LDKConfirmationTarget_MaximumFeeEstimate:
    case ConfirmationTarget.LDKConfirmationTarget_UrgentOnChainSweep:
      return 1
    case ConfirmationTarget.LDKConfirmationTarget_AnchorChannelFee:
    case ConfirmationTarget.LDKConfirmationTarget_NonAnchorChannelFee:
      return 6
    case ConfirmationTarget.LDKConfirmationTarget_ChannelCloseMinimum:
    case ConfirmationTarget.LDKConfirmationTarget_OutputSpendingFee:
      return 12
    case ConfirmationTarget.LDKConfirmationTarget_MinAllowedAnchorChannelRemoteFee:
    case ConfirmationTarget.LDKConfirmationTarget_MinAllowedNonAnchorChannelRemoteFee:
      return 144
    default:
      return 6
  }
}

export function createFeeEstimator(): FeeEstimator {
  return FeeEstimator.new_impl({
    get_est_sat_per_1000_weight(confirmation_target: ConfirmationTarget): number {
      const targetBlocks = targetToBlocks(confirmation_target)
      const satPerVb = getCachedFeeRate(targetBlocks)
      // Convert sat/vB → sat/KW (×250), cap, and enforce LDK minimum of 253
      const satKw = Math.min(Math.round(satPerVb * 250), MAX_FEE_SAT_KW)
      return Math.max(satKw, DEFAULT_FEE_RATES[confirmation_target] ?? 253, 253)
    },
  })
}
