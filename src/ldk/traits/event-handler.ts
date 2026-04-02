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
  Event_PaymentPathSuccessful,
  Event_PaymentPathFailed,
  Event_HTLCHandlingFailed,
  PaymentPurpose_Bolt11InvoicePayment,
  PaymentPurpose_SpontaneousPayment,
  Option_ThirtyTwoBytesZ_Some,
  Option_u64Z_Some,
  Option_PaymentFailureReasonZ_Some,
  PaymentFailureReason,
  Result_NoneReplayEventZ,
  SocketAddress_TcpIpV4,
  SocketAddress_TcpIpV6,
  SocketAddress_Hostname,
  type BumpTransactionEventHandler,
  type ClosureReason,
  ClosureReason_CounterpartyForceClosed,
  ClosureReason_HolderForceClosed,
  ClosureReason_LegacyCooperativeClosure,
  ClosureReason_CounterpartyInitiatedCooperativeClosure,
  ClosureReason_LocallyInitiatedCooperativeClosure,
  ClosureReason_CommitmentTxConfirmed,
  ClosureReason_FundingTimedOut,
  ClosureReason_ProcessingError,
  ClosureReason_DisconnectedPeer,
  ClosureReason_OutdatedChannelManager,
  ClosureReason_CounterpartyCoopClosedUnfundedChannel,
  ClosureReason_FundingBatchClosure,
  ClosureReason_HTLCsTimedOut,
  ClosureReason_PeerFeerateTooLow,
  type ChannelManager,
  type KeysManager,
  type SocketAddress,
  type Event,
} from 'lightningdevkit'
import { Wallet, Recipient, ScriptBuf, Amount, SignOptions } from '@bitcoindevkit/bdk-wallet-web'
import { idbPut, idbGet, idbDelete } from '../../storage/idb'
import { persistPayment, updatePaymentStatus } from '../storage/payment-history'
import { bytesToHex } from '../utils'
import { revealNextAddress } from '../../onchain/address-utils'
import { putChangeset } from '../../onchain/storage/changeset'
import { broadcastWithRetry } from './broadcaster'
import { ONCHAIN_CONFIG } from '../../onchain/config'
import { LDK_CONFIG } from '../config'
import { sweepSpendableOutputs } from '../sweep'
import { captureError } from '../../storage/error-log'

const MAX_FORWARD_DELAY_MS = 10_000

export type PaymentEventCallback = (
  event:
    | { type: 'sent'; paymentHash: string; preimage: Uint8Array; feePaidMsat: bigint | null }
    | { type: 'failed'; paymentHash: string; reason: string }
    | { type: 'claimed'; paymentHash: string; amountMsat: bigint }
) => void

export type ChannelClosedCallback = (counterpartyPubkeyHex: string) => void

export type SyncNeededCallback = () => void

export type ConnectionNeededCallback = (nodeIdHex: string, host: string, port: number) => void

export function createEventHandler(
  channelManager: ChannelManager,
  keysManager: KeysManager,
  bdkWallet: Wallet,
  lspNodeId: string,
  onPaymentEvent?: PaymentEventCallback,
  onChannelClosed?: ChannelClosedCallback,
  onSyncNeeded?: SyncNeededCallback,
  onConnectionNeeded?: ConnectionNeededCallback,
  bumpTxHandler?: BumpTransactionEventHandler
): {
  handler: EventHandler
  cleanup: () => void
} {
  let forwardTimerId: ReturnType<typeof setTimeout> | null = null

  const handler = EventHandler.new_impl({
    handle_event(event: Event): Result_NoneReplayEventZ {
      try {
        handleEvent(
          event,
          channelManager,
          keysManager,
          bdkWallet,
          lspNodeId,
          (id) => {
            if (forwardTimerId !== null) clearTimeout(forwardTimerId)
            forwardTimerId = id
          },
          onPaymentEvent,
          onChannelClosed,
          onSyncNeeded,
          onConnectionNeeded,
          bumpTxHandler
        )
      } catch (err: unknown) {
        captureError('critical', 'LDK Event', 'Unhandled error in event handler', String(err))
      }
      return Result_NoneReplayEventZ.constructor_ok()
    },
  })

  // Startup sweep recovery: sweep any SpendableOutputs persisted from a
  // previous session (crash recovery). BDK wallet is always available now.
  const destinationScript = revealNextAddress(bdkWallet, 'LDK')
  void sweepSpendableOutputs(
    keysManager,
    destinationScript,
    ONCHAIN_CONFIG.esploraUrl,
    LDK_CONFIG.esploraFallbackUrl
  )
    .then((result) => {
      if (result.swept > 0) {
        console.log('[LDK] Startup sweep: swept', result.swept, 'output(s), txid:', result.txid)
      }
    })
    .catch((err: unknown) => {
      console.warn('[LDK] Startup sweep failed (will retry on next SpendableOutputs event):', err)
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
  keysManager: KeysManager,
  bdkWallet: Wallet,
  lspNodeId: string,
  setForwardTimer: (id: ReturnType<typeof setTimeout>) => void,
  onPaymentEvent?: PaymentEventCallback,
  onChannelClosed?: ChannelClosedCallback,
  onSyncNeeded?: SyncNeededCallback,
  onConnectionNeeded?: ConnectionNeededCallback,
  bumpTxHandler?: BumpTransactionEventHandler
): void {
  // Payment events
  if (event instanceof Event_PaymentClaimable) {
    const paymentHashHex = bytesToHex(event.payment_hash)
    const purpose = event.purpose
    const purposeType =
      purpose instanceof PaymentPurpose_Bolt11InvoicePayment
        ? 'Bolt11InvoicePayment'
        : purpose instanceof PaymentPurpose_SpontaneousPayment
          ? 'SpontaneousPayment'
          : purpose.constructor.name

    console.log(
      '[LDK Event] PaymentClaimable:',
      'paymentHash:',
      paymentHashHex.substring(0, 16) + '…',
      'amount_msat:',
      event.amount_msat.toString(),
      'purpose:',
      purposeType
    )

    const preimage = purpose.preimage()
    if (preimage instanceof Option_ThirtyTwoBytesZ_Some) {
      channelManager.claim_funds(preimage.some)
    } else {
      console.warn(
        '[LDK Event] PaymentClaimable: no preimage available for',
        paymentHashHex,
        'purpose:',
        purposeType,
        '— payment cannot be claimed and will timeout'
      )
    }
    return
  }

  if (event instanceof Event_PaymentClaimed) {
    const paymentHash = bytesToHex(event.payment_hash)
    console.log(
      '[LDK Event] PaymentClaimed:',
      paymentHash,
      'amount_msat:',
      event.amount_msat.toString()
    )
    void persistPayment({
      paymentHash,
      direction: 'inbound',
      amountMsat: event.amount_msat,
      status: 'succeeded',
      feePaidMsat: null,
      createdAt: Date.now(),
      failureReason: null,
    }).catch((err: unknown) =>
      captureError('critical', 'LDK Event', 'Failed to persist inbound payment', String(err))
    )
    onPaymentEvent?.({ type: 'claimed', paymentHash, amountMsat: event.amount_msat })
    return
  }

  if (event instanceof Event_PaymentSent) {
    const paymentHash = bytesToHex(event.payment_hash)
    const paymentIdHex =
      event.payment_id instanceof Option_ThirtyTwoBytesZ_Some
        ? bytesToHex(event.payment_id.some)
        : paymentHash
    const feePaid = event.fee_paid_msat
    const feePaidMsat = feePaid instanceof Option_u64Z_Some ? feePaid.some : null
    console.log('[LDK Event] PaymentSent:', paymentHash)
    void updatePaymentStatus(paymentIdHex, 'succeeded', feePaidMsat).catch((err: unknown) =>
      captureError('critical', 'LDK Event', 'Failed to update outbound payment status', String(err))
    )
    onPaymentEvent?.({
      type: 'sent',
      paymentHash: paymentIdHex,
      preimage: event.payment_preimage,
      feePaidMsat,
    })
    return
  }

  if (event instanceof Event_PaymentFailed) {
    const paymentIdHex = bytesToHex(event.payment_id)
    const paymentHash =
      event.payment_hash instanceof Option_ThirtyTwoBytesZ_Some
        ? bytesToHex(event.payment_hash.some)
        : paymentIdHex
    const reasonOpt = event.reason
    let reason = 'Payment failed'
    if (reasonOpt instanceof Option_PaymentFailureReasonZ_Some) {
      reason = describePaymentFailure(reasonOpt.some)
    }
    console.warn('[LDK Event] PaymentFailed:', paymentHash, reason)
    void updatePaymentStatus(paymentIdHex, 'failed', null, reason).catch((err: unknown) =>
      captureError('error', 'LDK Event', 'Failed to update failed payment status', String(err))
    )
    onPaymentEvent?.({ type: 'failed', paymentHash: paymentIdHex, reason })
    return
  }

  // HTLC forwarding — deduplicate by clearing previous timer
  if (event instanceof Event_PendingHTLCsForwardable) {
    const delayMs = Math.min(Number(event.time_forwardable) * 1000, MAX_FORWARD_DELAY_MS)
    setForwardTimer(
      setTimeout(() => {
        channelManager.process_pending_htlc_forwards()
      }, delayMs)
    )
    return
  }

  // Channel lifecycle
  if (event instanceof Event_ChannelPending) {
    const channelIdHex = bytesToHex(event.channel_id.write())
    const tempIdHex = bytesToHex(event.former_temporary_channel_id.write())
    console.log(
      '[LDK Event] ChannelPending:',
      'channelId:',
      channelIdHex.substring(0, 16) + '…',
      'counterparty:',
      bytesToHex(event.counterparty_node_id).substring(0, 16) + '…'
    )
    // Store final→temp channel ID mapping so DiscardFunding can clean up
    // orphaned funding tx entries keyed by temporary channel ID.
    void idbPut('ldk_channel_id_map', channelIdHex, tempIdHex).catch((err: unknown) =>
      console.warn('[LDK Event] Failed to persist channel ID mapping:', err)
    )
    return
  }

  if (event instanceof Event_ChannelReady) {
    console.log(
      '[LDK Event] ChannelReady:',
      'channelId:',
      bytesToHex(event.channel_id.write()).substring(0, 16) + '…',
      'counterparty:',
      bytesToHex(event.counterparty_node_id).substring(0, 16) + '…'
    )
    return
  }

  if (event instanceof Event_ChannelClosed) {
    const channelIdHex = bytesToHex(event.channel_id.write())
    const reason = describeClosureReason(event.reason)
    console.log('[LDK Event] ChannelClosed:', channelIdHex, 'reason:', reason)

    // Notify caller so they can clean up peer storage if no channels remain.
    const peerPubkeyHex = bytesToHex(event.counterparty_node_id)
    const hasRemainingChannels = channelManager.list_channels().some((ch) => {
      return bytesToHex(ch.get_counterparty().get_node_id()) === peerPubkeyHex
    })
    if (!hasRemainingChannels) {
      onChannelClosed?.(peerPubkeyHex)
    }

    // Trigger immediate BDK wallet sync so on-chain balance reflects
    // the closing transaction output (cooperative close pays directly
    // to BDK's shutdown script address).
    onSyncNeeded?.()

    // Clean up channel ID mapping (best-effort)
    void idbDelete('ldk_channel_id_map', channelIdHex).catch(() => {})
    return
  }

  // Spendable outputs — persist descriptors to IDB then attempt immediate sweep.
  // Note: The IDB write is async but handle_event is sync. If the browser
  // crashes before the write commits, descriptors may be lost. This is a
  // known limitation of the sync/async bridge — the risk window is small
  // (IDB writes are typically <10ms) but not zero.
  if (event instanceof Event_SpendableOutputs) {
    const key = crypto.randomUUID()
    const serialized = event.outputs.map((o) => o.write())
    void idbPut('ldk_spendable_outputs', key, serialized)
      .then(() => {
        const destinationScript = revealNextAddress(bdkWallet, 'LDK Event')
        return sweepSpendableOutputs(
          keysManager,
          destinationScript,
          ONCHAIN_CONFIG.esploraUrl,
          LDK_CONFIG.esploraFallbackUrl
        )
      })
      .then((result) => {
        if (result && result.swept > 0) {
          console.log(
            '[LDK Event] SpendableOutputs: swept',
            result.swept,
            'output(s), txid:',
            result.txid
          )
        }
      })
      .catch((err: unknown) => {
        captureError(
          'critical',
          'Event:SpendableOutputs',
          'Failed to persist/sweep outputs',
          String(err)
        )
      })
    console.log(
      '[LDK Event] SpendableOutputs: persisting',
      event.outputs.length,
      'descriptor(s) and attempting sweep'
    )
    return
  }

  // Peer reconnection — parse first usable address and reconnect
  if (event instanceof Event_ConnectionNeeded) {
    const nodeIdHex = bytesToHex(event.node_id)
    const parsed = parseFirstSocketAddress(event.addresses)
    if (parsed && onConnectionNeeded) {
      console.log(
        '[LDK Event] ConnectionNeeded:',
        nodeIdHex.substring(0, 16) + '…',
        'connecting to',
        `${parsed.host}:${parsed.port}`
      )
      onConnectionNeeded(nodeIdHex, parsed.host, parsed.port)
    } else {
      console.warn(
        '[LDK Event] ConnectionNeeded:',
        nodeIdHex.substring(0, 16) + '…',
        parsed ? '— no callback registered' : '— no usable address in event'
      )
    }
    return
  }

  // Channel funding — build funding tx with BDK wallet, extract raw bytes,
  // and pass to LDK's funding_transaction_generated().
  // Wrapped in async IIFE: handle_event returns ok() immediately, the async
  // work runs in the background. This lets us await IDB persistence before
  // notifying LDK, preventing fund loss if persistence fails.
  if (event instanceof Event_FundingGenerationReady) {
    void (async () => {
      try {
        const scriptPubkey = ScriptBuf.from_bytes(event.output_script)
        const amount = Amount.from_sat(event.channel_value_satoshis)
        const recipient = new Recipient(scriptPubkey, amount)

        // TxBuilder methods consume self — must chain calls.
        // nlocktime(0) required: LDK rejects funding txs with non-final locktime,
        // and BDK defaults to current block height for anti-fee-sniping.
        const psbt = bdkWallet.build_tx().nlocktime(0).add_recipient(recipient).finish()
        bdkWallet.sign(psbt, new SignOptions())

        // Extract raw tx bytes from the signed PSBT via native BDK API
        const rawTxBytes = psbt.extract_tx().to_bytes()

        // Persist funding tx to IDB BEFORE notifying LDK. If IDB fails,
        // abort the channel (it will timeout) — no fund loss since the tx
        // was never broadcast.
        const tempChannelIdHex = bytesToHex(event.temporary_channel_id.write())
        const txHex = bytesToHex(rawTxBytes)
        try {
          await idbPut('ldk_funding_txs', tempChannelIdHex, txHex)
        } catch (err: unknown) {
          captureError(
            'critical',
            'LDK Event',
            'Failed to persist funding tx — aborting channel',
            String(err)
          )
          return
        }

        // Notify LDK of the funding transaction
        const result = channelManager.funding_transaction_generated(
          event.temporary_channel_id,
          event.counterparty_node_id,
          rawTxBytes
        )
        if (!result.is_ok()) {
          captureError(
            'critical',
            'LDK Event',
            'FundingGenerationReady: funding_transaction_generated failed'
          )
          return
        }

        console.log(
          '[LDK Event] FundingGenerationReady: funding tx registered',
          'channel_value:',
          event.channel_value_satoshis.toString(),
          'sats',
          'tempChannelId:',
          tempChannelIdHex.substring(0, 16) + '...'
        )

        // Persist wallet state after successful funding. Awaited to prevent
        // changeset loss on crash (per learnings: bdk-address-reveal-not-persisted).
        const changeset = bdkWallet.take_staged()
        if (changeset && !changeset.is_empty()) {
          await putChangeset(changeset.to_json()).catch((err: unknown) =>
            captureError(
              'critical',
              'BDK',
              'Failed to persist changeset after funding tx',
              String(err)
            )
          )
        }
      } catch (err: unknown) {
        captureError(
          'critical',
          'LDK Event',
          'FundingGenerationReady: failed to build funding tx',
          String(err)
        )
      }
    })()
    return
  }

  if (event instanceof Event_FundingTxBroadcastSafe) {
    const tempChannelIdHex = bytesToHex(event.former_temporary_channel_id.write())
    void broadcastPersistedFundingTx(tempChannelIdHex).catch((err: unknown) => {
      captureError('critical', 'LDK Event', 'FundingTxBroadcastSafe: broadcast failed', String(err))
    })
    return
  }

  if (event instanceof Event_BumpTransaction) {
    if (bumpTxHandler) {
      console.log('[LDK Event] BumpTransaction: handling CPFP fee bump')
      try {
        bumpTxHandler.handle_event(event.bump_transaction)
      } catch (err: unknown) {
        captureError('critical', 'Event:BumpTransaction', 'CPFP handling failed', String(err))
      }
    } else {
      captureError(
        'critical',
        'Event:BumpTransaction',
        'No handler configured — force-close tx may be stuck'
      )
    }
    return
  }

  if (event instanceof Event_DiscardFunding) {
    const channelIdHex = bytesToHex(event.channel_id.write())
    console.log('[LDK Event] DiscardFunding:', channelIdHex.substring(0, 16) + '...')
    // Look up the temporary channel ID from the mapping stored in ChannelPending,
    // then delete the orphaned funding tx and the mapping itself.
    void (async () => {
      try {
        const tempIdHex = await idbGet<string>('ldk_channel_id_map', channelIdHex)
        if (tempIdHex) {
          await idbDelete('ldk_funding_txs', tempIdHex)
          await idbDelete('ldk_channel_id_map', channelIdHex)
          console.log(
            '[LDK Event] DiscardFunding: cleaned up funding tx for',
            tempIdHex.substring(0, 16) + '...'
          )
        }
      } catch (err: unknown) {
        console.warn('[LDK Event] DiscardFunding: cleanup failed:', err)
      }
    })()
    return
  }

  // Payment path events — informational only, no action needed.
  // Full payment outcome is handled by PaymentSent / PaymentFailed.
  if (event instanceof Event_PaymentPathSuccessful || event instanceof Event_PaymentPathFailed) {
    return
  }

  // Inbound channel requests — accept 0-conf from configured LSP only.
  // Reject from unknown peers to prevent channel griefing and UTXO bloat.
  if (event instanceof Event_OpenChannelRequest) {
    // Use bytesToHex() directly, never .write() (see learnings: ldk-wasm-write-vs-direct-uint8array)
    const counterpartyHex = bytesToHex(event.counterparty_node_id)

    if (counterpartyHex === lspNodeId && lspNodeId !== '') {
      // Generate user_channel_id with 8 random bytes (not 16) to avoid u128 encoding bug
      // See learnings: ldk-wasm-encode-uint128-asymmetry
      const randomBytes = new Uint8Array(8)
      crypto.getRandomValues(randomBytes)
      const userChannelId = randomBytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n)
      const result = channelManager.accept_inbound_channel_from_trusted_peer_0conf(
        event.temporary_channel_id,
        event.counterparty_node_id,
        userChannelId
      )
      if (result.is_ok()) {
        console.log(
          '[LDK Event] OpenChannelRequest: accepted 0-conf from LSP',
          'tempChannelId:',
          bytesToHex(event.temporary_channel_id.write()).substring(0, 16) + '…'
        )
      } else {
        captureError('error', 'LDK Event', 'OpenChannelRequest: failed to accept 0-conf from LSP')
      }
    } else {
      console.log(
        '[LDK Event] OpenChannelRequest: rejected from non-LSP peer',
        counterpartyHex.substring(0, 16) + '...'
      )
      // Will timeout automatically — no explicit rejection needed
    }
    return
  }

  if (event instanceof Event_HTLCHandlingFailed) {
    captureError(
      'error',
      'LDK Event',
      `HTLCHandlingFailed: channelId: ${bytesToHex(event.prev_channel_id.write())} failedNextDestination: ${event.failed_next_destination.constructor.name}`
    )
    return
  }

  // Catch-all for unhandled event types (future LDK versions may add new events)
  console.log('[LDK Event] Unhandled event type:', event.constructor.name)
}

async function broadcastPersistedFundingTx(tempChannelIdHex: string): Promise<void> {
  const txHex = await idbGet<string>('ldk_funding_txs', tempChannelIdHex)
  if (!txHex) {
    console.warn(
      '[LDK Event] FundingTxBroadcastSafe: no persisted tx for',
      tempChannelIdHex.substring(0, 16) + '...'
    )
    return
  }
  const txid = await broadcastWithRetry(ONCHAIN_CONFIG.esploraUrl, txHex)
  void idbDelete('ldk_funding_txs', tempChannelIdHex).catch(() => {})
  console.log('[LDK Event] FundingTxBroadcastSafe: broadcast tx:', txid)
}

function parseFirstSocketAddress(
  addresses: SocketAddress[]
): { host: string; port: number } | null {
  for (const addr of addresses) {
    if (addr instanceof SocketAddress_TcpIpV4) {
      const bytes = addr.addr
      const host = `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`
      return { host, port: addr.port }
    }
    if (addr instanceof SocketAddress_TcpIpV6) {
      const b = addr.addr
      const groups: string[] = []
      for (let i = 0; i < 16; i += 2) {
        groups.push(((b[i]! << 8) | b[i + 1]!).toString(16))
      }
      return { host: groups.join(':'), port: addr.port }
    }
    if (addr instanceof SocketAddress_Hostname) {
      return { host: addr.hostname.to_str(), port: addr.port }
    }
  }
  return null
}

function describeClosureReason(reason: ClosureReason): string {
  if (reason instanceof ClosureReason_CounterpartyForceClosed) return 'Counterparty force closed'
  if (reason instanceof ClosureReason_HolderForceClosed) return 'Force closed by you'
  if (reason instanceof ClosureReason_LegacyCooperativeClosure) return 'Cooperative close'
  if (reason instanceof ClosureReason_CounterpartyInitiatedCooperativeClosure)
    return 'Cooperative close (initiated by peer)'
  if (reason instanceof ClosureReason_LocallyInitiatedCooperativeClosure) return 'Cooperative close'
  if (reason instanceof ClosureReason_CommitmentTxConfirmed)
    return 'Commitment transaction confirmed'
  if (reason instanceof ClosureReason_FundingTimedOut) return 'Funding timed out'
  if (reason instanceof ClosureReason_ProcessingError) return 'Processing error'
  if (reason instanceof ClosureReason_DisconnectedPeer) return 'Peer disconnected'
  if (reason instanceof ClosureReason_OutdatedChannelManager) return 'Outdated channel manager'
  if (reason instanceof ClosureReason_CounterpartyCoopClosedUnfundedChannel)
    return 'Counterparty closed unfunded channel'
  if (reason instanceof ClosureReason_FundingBatchClosure) return 'Funding batch closure'
  if (reason instanceof ClosureReason_HTLCsTimedOut) return 'HTLCs timed out'
  if (reason instanceof ClosureReason_PeerFeerateTooLow) return 'Peer feerate too low'
  return 'Channel closed'
}

function describePaymentFailure(reason: PaymentFailureReason): string {
  switch (reason) {
    case PaymentFailureReason.LDKPaymentFailureReason_RecipientRejected:
      return 'Payment was rejected by the recipient'
    case PaymentFailureReason.LDKPaymentFailureReason_UserAbandoned:
      return 'Payment was cancelled'
    case PaymentFailureReason.LDKPaymentFailureReason_RetriesExhausted:
      return 'No route found after multiple attempts'
    case PaymentFailureReason.LDKPaymentFailureReason_PaymentExpired:
      return 'Payment expired'
    case PaymentFailureReason.LDKPaymentFailureReason_RouteNotFound:
      return 'No route found to the recipient'
    case PaymentFailureReason.LDKPaymentFailureReason_UnexpectedError:
      return 'An unexpected error occurred'
    case PaymentFailureReason.LDKPaymentFailureReason_UnknownRequiredFeatures:
      return 'Recipient requires unsupported features'
    case PaymentFailureReason.LDKPaymentFailureReason_InvoiceRequestExpired:
      return 'Invoice request timed out — recipient may be offline'
    case PaymentFailureReason.LDKPaymentFailureReason_InvoiceRequestRejected:
      return 'Invoice request was rejected by the recipient'
    default:
      return 'Payment failed'
  }
}
