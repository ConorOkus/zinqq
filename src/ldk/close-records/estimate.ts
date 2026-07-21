import {
  ConfirmationTarget,
  Balance_ClaimableOnChannelClose,
  Option_u16Z_Some,
  type ChannelManager,
  type ChainMonitor,
  type ChannelDetails,
} from 'lightningdevkit'
import { bytesToHex } from '../utils'
import { getFeeRate } from '../../shared/fee-cache'
import { computeFeeRateSatKw } from '../traits/fee-estimator'
import { captureError } from '../../storage/error-log'

// A 1-input, 2-output P2WPKH mutual closing transaction is ~600-700 WU.
// Used only for the pre-close estimate shown to the user, never for signing.
const COOP_CLOSE_WEIGHT_WU = 700
// Matches the recovery-state deposit heuristic (recovery-state.ts): a sweep
// spending one force-close output to a P2WPKH address is ~140 vB.
const SWEEP_VBYTES = 140
// Anchor output spend + enough CPFP headroom to bump the commitment package.
const CPFP_VBYTES = 200

export interface CloseEstimateDeps {
  channelManager: ChannelManager
  chainMonitor: ChainMonitor
}

/**
 * Pre-close estimate for the confirm screen and `window.__closeRecords.estimate`.
 *
 * Every field is independently nullable: null means "estimate unavailable",
 * and the UI renders a placeholder for that field. The function itself never
 * throws and must never gate closing — a user who can't force-close because
 * an estimate fetch hangs can't unilaterally exit a misbehaving counterparty.
 */
export interface CloseEstimate {
  /** Who pays the close-transaction fee itself (the channel funder). */
  feePayer: 'you' | 'counterparty' | 'unknown'
  /** Estimated mutual-close tx fee (paid by the funder). */
  coopCloseFeeSats: bigint | null
  /** Force close: commitment tx fee, pre-committed in the channel (0n when the counterparty funds). */
  commitmentFeeSats: bigint | null
  /** Force close, anchor channels: estimated anchor fee-bump (CPFP) cost. */
  cpfpFeeSats: bigint | null
  /** Force close: estimated cost of sweeping funds back to the wallet. */
  sweepFeeSats: bigint | null
  /** What the user pays for a cooperative close. */
  coopTotalYouPaySats: bigint | null
  /** What the user pays for a force close. */
  forceTotalYouPaySats: bigint | null
  /** Claimable balance if the channel closed now (excludes in-flight HTLCs). */
  expectedBackSats: bigint | null
  /** Force close: blocks the user waits before funds can be swept (to_self_delay). */
  timelockBlocks: number | null
  pendingHtlcCount: number | null
  isAnchor: boolean | null
}

/** ~10 minutes per block, rendered as the largest sensible unit. */
export function humanizeBlocks(blocks: number): string {
  const minutes = blocks * 10
  if (minutes < 60) return `~${String(minutes)} minutes`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `~${String(hours)} ${hours === 1 ? 'hour' : 'hours'}`
  return `~${String(Math.round(hours / 24))} days`
}

function findChannel(
  channelManager: ChannelManager,
  channelIdHex: string
): { channel: ChannelDetails; others: ChannelDetails[] } | null {
  const all = channelManager.list_channels()
  const channel = all.find((ch) => bytesToHex(ch.get_channel_id().write()) === channelIdHex)
  if (!channel) return null
  return { channel, others: all.filter((ch) => ch !== channel) }
}

/**
 * The commitment fee is pre-committed in the channel and knowable before
 * broadcast via Balance_ClaimableOnChannelClose. ChainMonitor's flat
 * get_claimable_balances carries no channel attribution, and per-monitor
 * reads are unavailable (LockedChannelMonitor exposes only free() in these
 * bindings) — so we ignore every *other* open channel and only trust the
 * result when exactly one ClaimableOnChannelClose entry remains.
 */
function readOnCloseBalance(
  chainMonitor: ChainMonitor,
  others: ChannelDetails[]
): { commitmentFeeSats: bigint; amountSats: bigint } | null {
  const onClose = chainMonitor
    .get_claimable_balances(others)
    .filter((b) => b instanceof Balance_ClaimableOnChannelClose)
  const balance = onClose.length === 1 ? onClose[0] : undefined
  if (!balance) return null

  const confirmed = balance.balance_candidates[balance.confirmed_balance_candidate_index]
  if (!confirmed) return null
  return {
    commitmentFeeSats: confirmed.get_transaction_fee_satoshis(),
    amountSats: confirmed.get_amount_satoshis(),
  }
}

function satsFromVbytes(satPerVb: number, vbytes: number): bigint {
  return BigInt(Math.max(1, Math.round(satPerVb * vbytes)))
}

export async function estimateClose(
  deps: CloseEstimateDeps,
  channelIdHex: string
): Promise<CloseEstimate | null> {
  const estimate: CloseEstimate = {
    feePayer: 'unknown',
    coopCloseFeeSats: null,
    commitmentFeeSats: null,
    cpfpFeeSats: null,
    sweepFeeSats: null,
    coopTotalYouPaySats: null,
    forceTotalYouPaySats: null,
    expectedBackSats: null,
    timelockBlocks: null,
    pendingHtlcCount: null,
    isAnchor: null,
  }

  let found: { channel: ChannelDetails; others: ChannelDetails[] } | null = null
  try {
    found = findChannel(deps.channelManager, channelIdHex)
  } catch (err: unknown) {
    captureError('warning', 'CloseEstimate', 'list_channels failed', String(err))
    return estimate
  }
  if (!found) return null
  const { channel, others } = found

  let isOutbound: boolean | null = null
  try {
    isOutbound = channel.get_is_outbound()
    estimate.feePayer = isOutbound ? 'you' : 'counterparty'
  } catch (err: unknown) {
    captureError('warning', 'CloseEstimate', 'is_outbound read failed', String(err))
  }

  try {
    const delay = channel.get_force_close_spend_delay()
    if (delay instanceof Option_u16Z_Some) estimate.timelockBlocks = delay.some
  } catch (err: unknown) {
    captureError('warning', 'CloseEstimate', 'force_close_spend_delay read failed', String(err))
  }

  try {
    estimate.pendingHtlcCount =
      channel.get_pending_inbound_htlcs().length + channel.get_pending_outbound_htlcs().length
  } catch (err: unknown) {
    captureError('warning', 'CloseEstimate', 'pending HTLC read failed', String(err))
  }

  try {
    estimate.isAnchor = channel.get_channel_type().supports_anchors_zero_fee_htlc_tx()
  } catch (err: unknown) {
    captureError('warning', 'CloseEstimate', 'channel_type read failed', String(err))
  }

  let onClose: { commitmentFeeSats: bigint; amountSats: bigint } | null = null
  try {
    onClose = readOnCloseBalance(deps.chainMonitor, others)
    if (onClose) {
      estimate.commitmentFeeSats = onClose.commitmentFeeSats
      estimate.expectedBackSats = onClose.amountSats
    }
  } catch (err: unknown) {
    captureError('warning', 'CloseEstimate', 'claimable balance read failed', String(err))
  }
  if (estimate.expectedBackSats === null) {
    try {
      estimate.expectedBackSats = channel.get_outbound_capacity_msat() / 1000n
    } catch (err: unknown) {
      captureError('warning', 'CloseEstimate', 'outbound capacity read failed', String(err))
    }
  }

  try {
    // Warm the fee cache once; individual reads below fall back to defaults.
    const [sweepRate, urgentRate] = await Promise.all([getFeeRate(6), getFeeRate(3)])

    const coopSatKw = computeFeeRateSatKw(
      ConfirmationTarget.LDKConfirmationTarget_ChannelCloseMinimum
    )
    estimate.coopCloseFeeSats = BigInt(Math.round((coopSatKw * COOP_CLOSE_WEIGHT_WU) / 1000))
    estimate.sweepFeeSats = satsFromVbytes(sweepRate, SWEEP_VBYTES)
    // Unknown anchor support must stay unknown — zeroing it would make the
    // force-close total look cheaper than it may be.
    estimate.cpfpFeeSats =
      estimate.isAnchor === null
        ? null
        : estimate.isAnchor
          ? satsFromVbytes(urgentRate, CPFP_VBYTES)
          : 0n
  } catch (err: unknown) {
    captureError('warning', 'CloseEstimate', 'fee rate fetch failed', String(err))
  }

  if (isOutbound !== null && estimate.coopCloseFeeSats !== null) {
    estimate.coopTotalYouPaySats = isOutbound ? estimate.coopCloseFeeSats : 0n
  }
  if (
    isOutbound !== null &&
    estimate.sweepFeeSats !== null &&
    estimate.cpfpFeeSats !== null &&
    (estimate.commitmentFeeSats !== null || !isOutbound)
  ) {
    estimate.forceTotalYouPaySats =
      (isOutbound ? (estimate.commitmentFeeSats ?? 0n) : 0n) +
      estimate.cpfpFeeSats +
      estimate.sweepFeeSats
  }

  return estimate
}
