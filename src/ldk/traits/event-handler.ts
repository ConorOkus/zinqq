import {
  EventHandler,
  Event_PaymentClaimable,
  Event_PaymentClaimed,
  Event_PaymentSent,
  Event_PaymentFailed,
  Event_PendingHTLCsForwardable,
  Event_SpendableOutputs,
  Event_ChannelPending,
  Event_ChannelReady,
  Event_ChannelClosed,
  Event_FundingGenerationReady,
  Event_FundingTxBroadcastSafe,
  Event_OpenChannelRequest,
  Event_ConnectionNeeded,
  Event_BumpTransaction,
  Event_DiscardFunding,
  Option_ThirtyTwoBytesZ_Some,
  Result_NoneReplayEventZ,
  type ChannelManager,
  type Event,
} from 'lightningdevkit'
import { idbPut } from '../storage/idb'
import { bytesToHex } from '../utils'

const MAX_FORWARD_DELAY_MS = 10_000

export function createEventHandler(channelManager: ChannelManager): {
  handler: EventHandler
  cleanup: () => void
} {
  let forwardTimerId: ReturnType<typeof setTimeout> | null = null

  const handler = EventHandler.new_impl({
    handle_event(event: Event): Result_NoneReplayEventZ {
      try {
        handleEvent(event, channelManager, (id) => {
          if (forwardTimerId !== null) clearTimeout(forwardTimerId)
          forwardTimerId = id
        })
      } catch (err: unknown) {
        console.error('[LDK Event] Unhandled error in event handler:', err)
      }
      return Result_NoneReplayEventZ.constructor_ok()
    },
  })

  return {
    handler,
    cleanup: () => {
      if (forwardTimerId !== null) {
        clearTimeout(forwardTimerId)
        forwardTimerId = null
      }
    },
  }
}

function handleEvent(
  event: Event,
  channelManager: ChannelManager,
  setForwardTimer: (id: ReturnType<typeof setTimeout>) => void,
): void {
  // Payment events
  if (event instanceof Event_PaymentClaimable) {
    const preimage = event.purpose.preimage()
    if (preimage instanceof Option_ThirtyTwoBytesZ_Some) {
      console.log(
        '[LDK Event] PaymentClaimable: claiming',
        bytesToHex(event.payment_hash),
        'amount_msat:',
        event.amount_msat.toString(),
      )
      channelManager.claim_funds(preimage.some)
    } else {
      // No preimage available — this can happen for keysend payments where
      // the preimage is not provided via purpose.preimage(). The payment
      // cannot be claimed without a preimage and will timeout.
      console.warn(
        '[LDK Event] PaymentClaimable: no preimage available for',
        bytesToHex(event.payment_hash),
        '— payment cannot be claimed and will timeout',
      )
    }
    return
  }

  if (event instanceof Event_PaymentClaimed) {
    console.log(
      '[LDK Event] PaymentClaimed:',
      bytesToHex(event.payment_hash),
      'amount_msat:',
      event.amount_msat.toString(),
    )
    return
  }

  if (event instanceof Event_PaymentSent) {
    console.log(
      '[LDK Event] PaymentSent:',
      bytesToHex(event.payment_hash),
    )
    return
  }

  if (event instanceof Event_PaymentFailed) {
    console.warn(
      '[LDK Event] PaymentFailed:',
      bytesToHex(event.payment_hash),
    )
    return
  }

  // HTLC forwarding — deduplicate by clearing previous timer
  if (event instanceof Event_PendingHTLCsForwardable) {
    const delayMs = Math.min(
      Number(event.time_forwardable) * 1000,
      MAX_FORWARD_DELAY_MS,
    )
    setForwardTimer(
      setTimeout(() => {
        channelManager.process_pending_htlc_forwards()
      }, delayMs),
    )
    return
  }

  // Channel lifecycle
  if (event instanceof Event_ChannelPending) {
    console.log(
      '[LDK Event] ChannelPending:',
      bytesToHex(event.channel_id.write()),
    )
    return
  }

  if (event instanceof Event_ChannelReady) {
    console.log(
      '[LDK Event] ChannelReady:',
      bytesToHex(event.channel_id.write()),
    )
    return
  }

  if (event instanceof Event_ChannelClosed) {
    console.log(
      '[LDK Event] ChannelClosed:',
      bytesToHex(event.channel_id.write()),
      'reason:',
      event.reason,
    )
    return
  }

  // Spendable outputs — persist descriptors to IDB for future sweep.
  // Note: The IDB write is async but handle_event is sync. If the browser
  // crashes before the write commits, descriptors may be lost. This is a
  // known limitation of the sync/async bridge — the risk window is small
  // (IDB writes are typically <10ms) but not zero.
  if (event instanceof Event_SpendableOutputs) {
    const key = crypto.randomUUID()
    const serialized = event.outputs.map((o) => o.write())
    void idbPut('ldk_spendable_outputs', key, serialized).catch(
      (err: unknown) => {
        console.error(
          '[LDK Event] CRITICAL: Failed to persist SpendableOutputs:',
          err,
        )
      },
    )
    console.log(
      '[LDK Event] SpendableOutputs: persisting',
      event.outputs.length,
      'descriptor(s) for future sweep',
    )
    return
  }

  // Peer reconnection — SocketAddress parsing not yet implemented
  if (event instanceof Event_ConnectionNeeded) {
    console.warn(
      '[LDK Event] ConnectionNeeded:',
      bytesToHex(event.node_id),
      '— SocketAddress parsing not yet implemented',
    )
    return
  }

  // Deferred events — no wallet/UTXO layer yet
  if (event instanceof Event_FundingGenerationReady) {
    console.warn(
      '[LDK Event] FundingGenerationReady: no wallet layer — cannot fund channel',
    )
    return
  }

  if (event instanceof Event_FundingTxBroadcastSafe) {
    console.warn('[LDK Event] FundingTxBroadcastSafe: no wallet layer')
    return
  }

  if (event instanceof Event_BumpTransaction) {
    console.warn(
      '[LDK Event] BumpTransaction: no wallet layer — cannot bump fees',
    )
    return
  }

  if (event instanceof Event_DiscardFunding) {
    console.log('[LDK Event] DiscardFunding')
    return
  }

  // Inbound channel requests — no acceptance policy yet, will timeout
  if (event instanceof Event_OpenChannelRequest) {
    console.log(
      '[LDK Event] OpenChannelRequest: ignoring (no acceptance policy, will timeout)',
    )
    return
  }

  // Catch-all for unhandled event types (future LDK versions may add new events)
  console.log('[LDK Event] Unhandled event type:', event.constructor.name)
}
