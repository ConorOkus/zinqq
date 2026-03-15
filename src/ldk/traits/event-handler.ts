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
import {
  Wallet,
  Recipient,
  ScriptBuf,
  Amount,
  SignOptions,
} from '@bitcoindevkit/bdk-wallet-web'
import { idbPut } from '../storage/idb'
import { bytesToHex } from '../utils'
import { putChangeset } from '../../onchain/storage/changeset'
import { extractTxBytes, broadcastTransaction } from '../../onchain/tx-bridge'
import { ONCHAIN_CONFIG } from '../../onchain/config'

const MAX_FORWARD_DELAY_MS = 10_000

export function createEventHandler(channelManager: ChannelManager): {
  handler: EventHandler
  cleanup: () => void
  setBdkWallet: (wallet: Wallet | null) => void
} {
  let forwardTimerId: ReturnType<typeof setTimeout> | null = null
  let bdkWallet: Wallet | null = null

  // In-memory cache of signed funding transactions waiting for FundingTxBroadcastSafe.
  // Keyed by temporary_channel_id hex → raw tx hex.
  // TEMPORARY: Remove when bdk-wasm exposes Transaction.to_bytes() (bdk-wasm#38)
  const fundingTxCache = new Map<string, string>()

  const handler = EventHandler.new_impl({
    handle_event(event: Event): Result_NoneReplayEventZ {
      try {
        handleEvent(event, channelManager, bdkWallet, fundingTxCache, (id) => {
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
      fundingTxCache.clear()
    },
    setBdkWallet: (wallet: Wallet | null) => {
      bdkWallet = wallet
    },
  }
}

function handleEvent(
  event: Event,
  channelManager: ChannelManager,
  bdkWallet: Wallet | null,
  fundingTxCache: Map<string, string>,
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

  // Channel funding — build funding tx with BDK wallet, extract raw bytes via
  // tx-bridge, and pass to LDK's funding_transaction_generated()
  if (event instanceof Event_FundingGenerationReady) {
    if (!bdkWallet) {
      console.warn(
        '[LDK Event] FundingGenerationReady: BDK wallet not available — cannot fund channel',
      )
      return
    }

    try {
      const scriptPubkey = ScriptBuf.from_bytes(event.output_script)
      const amount = Amount.from_sat(event.channel_value_satoshis)
      const recipient = new Recipient(scriptPubkey, amount)

      // TxBuilder methods consume self — must chain calls
      const psbt = bdkWallet.build_tx().add_recipient(recipient).finish()
      bdkWallet.sign(psbt, new SignOptions())

      // Extract raw tx bytes from signed PSBT via @scure/btc-signer bridge
      const rawTxBytes = extractTxBytes(psbt.toString())

      // Notify LDK of the funding transaction
      const result = channelManager.funding_transaction_generated(
        event.temporary_channel_id,
        event.counterparty_node_id,
        rawTxBytes,
      )
      if (!result.is_ok()) {
        console.error(
          '[LDK Event] FundingGenerationReady: funding_transaction_generated failed',
        )
        return
      }

      // Cache the raw tx hex for broadcasting when FundingTxBroadcastSafe fires
      const tempChannelIdHex = bytesToHex(event.temporary_channel_id.write())
      const txHex = bytesToHex(rawTxBytes)
      fundingTxCache.set(tempChannelIdHex, txHex)

      console.log(
        '[LDK Event] FundingGenerationReady: funding tx registered',
        'channel_value:', event.channel_value_satoshis.toString(), 'sats',
        'tempChannelId:', tempChannelIdHex.substring(0, 16) + '...',
      )

      // Persist wallet state after successful funding
      const changeset = bdkWallet.take_staged()
      if (changeset && !changeset.is_empty()) {
        void putChangeset(changeset.to_json()).catch((err: unknown) =>
          console.error('[BDK] CRITICAL: failed to persist changeset after funding tx', err),
        )
      }
    } catch (err: unknown) {
      console.error(
        '[LDK Event] FundingGenerationReady: failed to build funding tx:',
        err,
      )
    }
    return
  }

  if (event instanceof Event_FundingTxBroadcastSafe) {
    const tempChannelIdHex = bytesToHex(event.former_temporary_channel_id.write())
    const txHex = fundingTxCache.get(tempChannelIdHex)

    if (txHex) {
      void broadcastTransaction(txHex, ONCHAIN_CONFIG.esploraUrl)
        .then((txid) => {
          fundingTxCache.delete(tempChannelIdHex)
          console.log('[LDK Event] FundingTxBroadcastSafe: broadcast tx:', txid)
        })
        .catch((err: unknown) => {
          console.error(
            '[LDK Event] FundingTxBroadcastSafe: broadcast failed (tx retained in cache):',
            err,
          )
        })
    } else {
      console.warn(
        '[LDK Event] FundingTxBroadcastSafe: no cached tx for',
        tempChannelIdHex.substring(0, 16) + '...',
        '— may have been cleaned up or tab was reloaded',
      )
    }
    return
  }

  if (event instanceof Event_BumpTransaction) {
    // TODO: Implement CPFP with BDK UTXOs for anchor channels
    console.warn(
      '[LDK Event] BumpTransaction: not yet implemented — cannot bump fees',
    )
    return
  }

  if (event instanceof Event_DiscardFunding) {
    // DiscardFunding provides channel_id (final, not temporary) so we cannot
    // directly look up the cached tx. The leaked cache entry is acceptable for
    // this temporary workaround — it's cleaned up on tab refresh.
    console.log(
      '[LDK Event] DiscardFunding:',
      bytesToHex(event.channel_id.write()).substring(0, 16) + '...',
    )
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
