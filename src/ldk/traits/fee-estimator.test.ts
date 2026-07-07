import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture the block targets `getCachedFeeRate` is asked for and return a
// recorded sat/vB so the assertions below can show "the 3-block rate was
// chosen, not the 1-block rate." Mocked at the module level so
// `createFeeEstimator()`'s synchronous callback uses our stub.
const ratesByTarget: Record<number, number> = {}
const getCachedFeeRateMock = vi.fn((target: number): number => {
  return ratesByTarget[target] ?? 1
})

vi.mock('../../shared/fee-cache', () => ({
  getCachedFeeRate: (target: number): number => getCachedFeeRateMock(target),
}))

import { ConfirmationTarget } from 'lightningdevkit'
import { computeFeeRateSatKw } from './fee-estimator'

describe('createFeeEstimator', () => {
  beforeEach(() => {
    getCachedFeeRateMock.mockClear()
    for (const k of Object.keys(ratesByTarget)) delete ratesByTarget[Number(k)]
  })

  it('uses the 3-block estimate for UrgentOnChainSweep, NOT the 1-block estimate', () => {
    // Low-fee mempool repro: Esplora's 1-block estimate is wildly higher
    // than its 3-block estimate. Picking 1-block here would overpay 25×.
    ratesByTarget[1] = 75 // sat/vB — what recent high-priority txs paid
    ratesByTarget[3] = 3
    ratesByTarget[6] = 2

    const satKw = computeFeeRateSatKw(ConfirmationTarget.LDKConfirmationTarget_UrgentOnChainSweep)

    // 3 sat/vB → 750 sat/kW → floored to 2_500 sat/kW (10 sat/vB) per
    // DEFAULT_FEE_RATES[UrgentOnChainSweep]. The point is: 3-block was
    // queried, NOT 1-block.
    expect(getCachedFeeRateMock).toHaveBeenCalledWith(3)
    expect(getCachedFeeRateMock).not.toHaveBeenCalledWith(1)
    // The default floor (10 sat/vB = 2_500 sat/kW) wins over the low cache rate.
    expect(satKw).toBe(2_500)
  })

  it('honors the MaximumFeeEstimate 1-block target (sanity ceiling)', () => {
    // MaximumFeeEstimate is meant to be the high estimate — it's used by LDK
    // as a sanity ceiling for force-close commitment fees, not for picking
    // an actual rate to pay. Keep it on 1-block.
    ratesByTarget[1] = 100

    const satKw = computeFeeRateSatKw(ConfirmationTarget.LDKConfirmationTarget_MaximumFeeEstimate)

    expect(getCachedFeeRateMock).toHaveBeenCalledWith(1)
    // 100 sat/vB → 25_000 sat/kW, above the 50_000 default → 25_000 wins.
    expect(satKw).toBe(50_000)
  })

  it('uses esplora rate when it exceeds the per-target default floor', () => {
    // High-fee mempool: 3-block rate is 50 sat/vB (12_500 sat/kW). The
    // UrgentOnChainSweep default floor is 2_500 sat/kW; esplora rate wins.
    ratesByTarget[3] = 50

    const satKw = computeFeeRateSatKw(ConfirmationTarget.LDKConfirmationTarget_UrgentOnChainSweep)

    expect(satKw).toBe(12_500) // 50 × 250
  })

  it('caps esplora rate at MAX_FEE_SAT_KW (~2,000 sat/vB)', () => {
    // Pathological esplora response. The cap is a fail-safe.
    ratesByTarget[3] = 5_000

    const satKw = computeFeeRateSatKw(ConfirmationTarget.LDKConfirmationTarget_UrgentOnChainSweep)

    expect(satKw).toBe(500_000)
  })

  // Regression guards for the LDK 1 sat/vB minimum on both *RemoteFee floors.
  // A non-anchor LSP can propose 253 sat/kW commitment feerates; raising either
  // floor above 253 brings back "Peer's feerate much too low".
  it('floors MinAllowedAnchorChannelRemoteFee at 253 sat/kW (LDK absolute min)', () => {
    ratesByTarget[144] = 0 // esplora returns nothing usable

    const satKw = computeFeeRateSatKw(
      ConfirmationTarget.LDKConfirmationTarget_MinAllowedAnchorChannelRemoteFee
    )

    expect(satKw).toBe(253)
  })

  it('floors MinAllowedNonAnchorChannelRemoteFee at 253 sat/kW (non-anchor LSP compatibility)', () => {
    ratesByTarget[144] = 0

    const satKw = computeFeeRateSatKw(
      ConfirmationTarget.LDKConfirmationTarget_MinAllowedNonAnchorChannelRemoteFee
    )

    expect(satKw).toBe(253)
  })
})
