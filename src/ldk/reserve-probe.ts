import type { ChannelManager } from 'lightningdevkit'
import { Option_u64Z_Some } from 'lightningdevkit'
import { bytesToHex } from './utils'
import { captureError } from '../storage/error-log'

/**
 * TEMPORARY probe (2026-07-24): record the channel reserve the LSP imposes on
 * us (`unspendable_punishment_reserve`) for every open channel, at startup and
 * on each ChannelReady.
 *
 * Why: the minimum-receive floor (`computeMinReceiveSats`) guarantees net > 0
 * after the opening fee, but a first receive whose net lands at or below OUR
 * channel reserve is visible-but-unspendable — arguably a worse surprise than
 * the fee deduction. Whether that can happen depends on what Megalith actually
 * sets: their docs don't say, and the value only exists per-channel in the
 * `open_channel` message (LDK-funded LSPs default to max(1% of capacity,
 * 1000 sats); true zero-reserve is also common for JIT). One real observation
 * decides whether the floor needs a reserve term. Remove this module and its
 * two call sites (context init, ChannelReady handler) once the number is
 * recorded.
 */
export function logObservedChannelReserves(channelManager: ChannelManager, when: string): void {
  try {
    const channels = channelManager.list_channels()
    if (channels.length === 0) return
    const observed = channels.map((ch) => {
      const reserve = ch.get_unspendable_punishment_reserve()
      return {
        channel_id: bytesToHex(ch.get_channel_id().write()).substring(0, 16),
        counterparty: bytesToHex(ch.get_counterparty().get_node_id()).substring(0, 16),
        channel_value_sats: ch.get_channel_value_satoshis().toString(),
        our_reserve_sats: reserve instanceof Option_u64Z_Some ? reserve.some.toString() : 'unknown',
      }
    })
    captureError(
      'warning',
      'LSP',
      `channel reserve probe (${when}) — does the receive floor need a reserve term?`,
      JSON.stringify(observed)
    )
  } catch (err) {
    console.warn('[reserve-probe] failed:', err)
  }
}
