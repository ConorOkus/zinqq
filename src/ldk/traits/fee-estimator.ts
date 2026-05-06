import { FeeEstimator, ConfirmationTarget } from 'lightningdevkit'
import { getCachedFeeRate } from '../../shared/fee-cache'

// Default fee rates in sat/KW (1 sat/vB = 250 sat/KW)
//
// UrgentOnChainSweep floor: 2,500 sat/kW (10 sat/vB). This is the minimum
// feerate for CPFP fee bumps during force-close recovery. A higher floor
// (like 25,000 / 100 sat/vB) makes CPFP fail when the on-chain wallet has
// limited funds — LDK's coin selection aborts if the UTXO value can't cover
// the target package fee. 10 sat/vB is comfortably above dust relay rate
// and will confirm within a few blocks under normal mempool conditions.
// The actual esplora rate still drives the estimate when it's higher.
const DEFAULT_FEE_RATES: Record<ConfirmationTarget, number> = {
  [ConfirmationTarget.LDKConfirmationTarget_MaximumFeeEstimate]: 50_000,
  [ConfirmationTarget.LDKConfirmationTarget_UrgentOnChainSweep]: 2_500,
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
      return 1
    case ConfirmationTarget.LDKConfirmationTarget_UrgentOnChainSweep:
      // Anchor-channel CPFP, justice transactions, and HTLC-claim txs.
      // Esplora's 1-block estimate is a sat-per-vB rate that recent
      // high-priority transactions paid — it's wildly inflated in low-fee
      // mempools (the network mined a block at 1 sat/vB but the 1-target
      // estimate can read 75+ sat/vB). The 3-block estimate is much more
      // stable and is still well within our safety windows: anchor channels
      // give us the full `to_self_delay` (typically 144+ blocks) before
      // the counterparty can race us on-chain. 3 blocks vs 1 block trades
      // ~30 minutes of confirmation latency for not paying 30× the going
      // rate during quiet mempool conditions.
      return 3
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

/**
 * Pure fee-rate computation: queries `getCachedFeeRate` for the right
 * block target, applies the per-target floor, and caps at MAX_FEE_SAT_KW.
 * Exported for testing — production code goes through `createFeeEstimator`.
 */
export function computeFeeRateSatKw(confirmationTarget: ConfirmationTarget): number {
  const targetBlocks = targetToBlocks(confirmationTarget)
  const satPerVb = getCachedFeeRate(targetBlocks)
  // Convert sat/vB → sat/KW (×250), cap, and enforce LDK minimum of 253
  const satKw = Math.min(Math.round(satPerVb * 250), MAX_FEE_SAT_KW)
  return Math.max(satKw, DEFAULT_FEE_RATES[confirmationTarget] ?? 253, 253)
}

export function createFeeEstimator(): FeeEstimator {
  return FeeEstimator.new_impl({
    get_est_sat_per_1000_weight: computeFeeRateSatKw,
  })
}
