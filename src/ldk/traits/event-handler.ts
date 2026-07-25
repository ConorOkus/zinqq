import {
  EventHandler,
  Event_PaymentClaimable,
  Event_PaymentClaimed,
  Event_PaymentSent,
  Event_PaymentFailed,
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
  type BumpTransactionEventHandlerSync,
  BumpTransactionEvent_ChannelClose,
  BumpTransactionEvent_HTLCResolution,
  SpendableOutputDescriptor,
  SpendableOutputDescriptor_StaticOutput,
  SpendableOutputDescriptor_DelayedPaymentOutput,
  SpendableOutputDescriptor_StaticPaymentOutput,
  Option_u16Z_Some,
  ChannelConfigOverrides,
  ChannelConfigUpdate,
  ChannelHandshakeConfigUpdate,
  Option_boolZ,
  Option_u8Z,
  Option_u16Z,
  Option_u32Z,
  Option_u64Z,
  Option_MaxDustHTLCExposureZ,
  type ChannelManager,
  type KeysManager,
  type SocketAddress,
  type Event,
} from 'lightningdevkit'
import {
  type Wallet,
  Recipient,
  ScriptBuf,
  Amount,
  SignOptions,
  Transaction,
} from '@bitcoindevkit/bdk-wallet-web'
import { idbPut, idbGet, idbDelete } from '../../storage/idb'
import { persistPayment, updatePaymentStatus } from '../storage/payment-history'
import { bytesToHex, txidBytesToHex } from '../utils'
import { classifyClosureReason } from '../close-records/closure-reason'
import { handleCloseSignal, recordSweepResult } from '../close-records/signals'
import { getCloseRecordSync, recordFundingTxo } from '../close-records/store'
import {
  sweepSpendableOutputs,
  isWalletOwnedStaticOutput,
  type SpendableOutputsEntry,
} from '../sweep'
import { revealNextAddress } from '../../onchain/address-utils'
import { putChangeset } from '../../onchain/storage/changeset'
import { broadcastWithRetry } from './broadcaster'
import { ONCHAIN_CONFIG, ANCHOR_RESERVE_SATS } from '../../onchain/config'
import { isInitialScanComplete } from '../../onchain/scan-state'
import { LDK_CONFIG } from '../config'
import { JIT_ACCEPT_UNDERPAYING_HTLCS, JIT_MAX_INBOUND_INFLIGHT_PCT } from '../jit-channel-config'
import { captureError } from '../../storage/error-log'

export type PaymentEventCallback = (
  event:
    | { type: 'sent'; paymentHash: string; preimage: Uint8Array; feePaidMsat: bigint | null }
    | { type: 'failed'; paymentHash: string; reason: string }
    | { type: 'claimed'; paymentHash: string; amountMsat: bigint }
) => void

export type ChannelClosedCallback = (counterpartyPubkeyHex: string) => void

export type SyncNeededCallback = () => void

export type ConnectionNeededCallback = (nodeIdHex: string, host: string, port: number) => void

export interface RecoveryNeededInfo {
  channelId: string
  /** Estimated stuck balance from the close record; null when unknown. */
  localBalanceSat: number | null
  reason: string
}

export type RecoveryNeededCallback = (info: RecoveryNeededInfo) => void

/**
 * Predicate consulted on `Event_OpenChannelRequest` to decide whether to
 * accept a 0-conf inbound channel. Backed by a mutable trust set
 * (see `LdkNode.trustedLspIds` in init.ts) so additional LSPs can be added
 * after handler creation (e.g. if a runtime discovery step is reintroduced).
 */
export type IsTrustedLsp = (pubkeyHex: string) => boolean

/**
 * Per-channel config overrides applied when accepting a JIT (0-conf) channel
 * from a trusted LSP. These pin the two settings the JIT receive flow depends
 * on directly on the accepted channel:
 *   - `accept_underpaying_htlcs = true` — the LSP deducts its opening fee from
 *     the forwarded HTLC, so the arriving amount is below the invoice amount.
 *   - inbound in-flight = 100% — otherwise a large forwarded HTLC is silently
 *     rejected (see docs/solutions: lsps2-jit-receive-channel-config).
 *
 * The values come from `jit-channel-config.ts`, the single source of truth also
 * consumed by the wallet-global `createUserConfig` (retained as the safety net),
 * so the per-channel override can never drift from the global default. Stating
 * them per-channel makes the JIT channel's requirements explicit. The 0.2
 * bindings added the `config_overrides` slot to the 0-conf accept call, which
 * pre-0.2 could only be set globally.
 */
function buildJitChannelConfigOverrides(): ChannelConfigOverrides {
  const updateOverrides = ChannelConfigUpdate.constructor_new(
    Option_u32Z.constructor_none(), // forwarding_fee_proportional_millionths
    Option_u32Z.constructor_none(), // forwarding_fee_base_msat
    Option_u16Z.constructor_none(), // cltv_expiry_delta
    Option_MaxDustHTLCExposureZ.constructor_none(), // max_dust_htlc_exposure_msat
    Option_u64Z.constructor_none(), // force_close_avoidance_max_fee_satoshis
    Option_boolZ.constructor_some(JIT_ACCEPT_UNDERPAYING_HTLCS) // accept_underpaying_htlcs
  )
  const handshakeOverrides = ChannelHandshakeConfigUpdate.constructor_new(
    Option_u8Z.constructor_some(JIT_MAX_INBOUND_INFLIGHT_PCT), // max_inbound_htlc_value_in_flight_percent_of_channel
    Option_u64Z.constructor_none(), // htlc_minimum_msat
    Option_u32Z.constructor_none(), // minimum_depth
    Option_u16Z.constructor_none(), // to_self_delay
    Option_u16Z.constructor_none(), // max_accepted_htlcs
    Option_u32Z.constructor_none() // channel_reserve_proportional_millionths
  )
  return ChannelConfigOverrides.constructor_new(handshakeOverrides, updateOverrides)
}

/** Keep the anchor-CPFP reserve out of subsidized sweeps while channels are open. */
function anchorReserveSats(channelManager: ChannelManager): bigint {
  return channelManager.list_channels().length > 0 ? ANCHOR_RESERVE_SATS : 0n
}

export function createEventHandler(
  channelManager: ChannelManager,
  keysManager: KeysManager,
  bdkWallet: Wallet,
  isTrustedLsp: IsTrustedLsp,
  onPaymentEvent?: PaymentEventCallback,
  onChannelClosed?: ChannelClosedCallback,
  onSyncNeeded?: SyncNeededCallback,
  onConnectionNeeded?: ConnectionNeededCallback,
  bumpTxHandler?: BumpTransactionEventHandlerSync,
  onRecoveryNeeded?: RecoveryNeededCallback
): {
  handler: EventHandler
  cleanup: () => void
} {
  const handler = EventHandler.new_impl({
    handle_event(event: Event): Result_NoneReplayEventZ {
      try {
        handleEvent(
          event,
          channelManager,
          keysManager,
          bdkWallet,
          isTrustedLsp,
          onPaymentEvent,
          onChannelClosed,
          onSyncNeeded,
          onConnectionNeeded,
          bumpTxHandler,
          onRecoveryNeeded
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
  void sweepSpendableOutputs({
    keysManager,
    bdkWallet,
    destinationScript,
    esploraUrl: ONCHAIN_CONFIG.esploraUrl,
    esploraFallbackUrl: LDK_CONFIG.esploraFallbackUrl,
    reserveSats: anchorReserveSats(channelManager),
  })
    .then((result) => {
      if (result.swept > 0) {
        recordSweepResult(result)
        console.log(
          '[LDK] Startup sweep: swept',
          result.swept,
          'output(s), txid(s):',
          result.txs.map((t) => t.txid).join(', ')
        )
      }
    })
    .catch((err: unknown) => {
      console.warn('[LDK] Startup sweep failed (will retry on next SpendableOutputs event):', err)
    })

  return {
    handler,
    // No teardown needed: HTLC-forward processing moved to the background poll
    // loop (needs_pending_htlc_processing) after LDK 0.2 removed
    // Event::PendingHTLCsForwardable. Retained for caller API stability.
    cleanup: () => {},
  }
}

function handleEvent(
  event: Event,
  channelManager: ChannelManager,
  keysManager: KeysManager,
  bdkWallet: Wallet,
  isTrustedLsp: IsTrustedLsp,
  onPaymentEvent?: PaymentEventCallback,
  onChannelClosed?: ChannelClosedCallback,
  onSyncNeeded?: SyncNeededCallback,
  onConnectionNeeded?: ConnectionNeededCallback,
  bumpTxHandler?: BumpTransactionEventHandlerSync,
  onRecoveryNeeded?: RecoveryNeededCallback
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

  // NOTE: LDK 0.2 removed Event::PendingHTLCsForwardable. HTLC forwarding is now
  // driven by polling channelManager.needs_pending_htlc_processing() in the
  // background timer loop (see context.tsx), which calls
  // process_pending_htlc_forwards() when work is pending.

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
    // Safety net for close records: if this channel later closes while the
    // tab is dying (crash between ok() and the record persist), reconciliation
    // recreates the record from this funding outpoint. to_self_delay is
    // captured here too — it becomes unreadable once the channel closes, and
    // reconciliation needs it to derive the timelock expiry height.
    let timelockBlocks: number | undefined
    try {
      const delay = channelManager
        .list_channels()
        .find((ch) => bytesToHex(ch.get_channel_id().write()) === channelIdHex)
        ?.get_force_close_spend_delay()
      if (delay instanceof Option_u16Z_Some) timelockBlocks = delay.some
    } catch {
      // best-effort — the funding txo below must still be recorded
    }
    try {
      const txo = event.funding_txo
      recordFundingTxo(channelIdHex, {
        txid: txidBytesToHex(txo.get_txid()),
        vout: txo.get_index(),
        ...(timelockBlocks !== undefined ? { timelockBlocks } : {}),
      }).catch(() => {})
    } catch (err: unknown) {
      console.warn('[LDK Event] Failed to record funding txo:', err)
    }
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
    const classification = classifyClosureReason(event.reason)
    console.log('[LDK Event] ChannelClosed:', channelIdHex, 'reason:', classification.description)

    // Drain event fields into a primitives-only signal synchronously — no
    // WASM handle may survive into the async persist path. Note: NO
    // channel-capacity fallback for the balance (it would overstate the
    // expected return by the entire capacity); unknown stays unknown.
    let fundingTxo: { txid: string; vout: number } | null = null
    try {
      const txo: unknown = event.channel_funding_txo
      if (txo) {
        const outPoint = event.channel_funding_txo
        fundingTxo = { txid: txidBytesToHex(outPoint.get_txid()), vout: outPoint.get_index() }
      }
    } catch {
      // Pre-0.0.120 serializations may lack the funding txo — degrade gracefully
    }
    const lastLocalBalanceSats =
      event.last_local_balance_msat instanceof Option_u64Z_Some
        ? event.last_local_balance_msat.some / 1000n
        : null
    handleCloseSignal({
      type: 'channel_closed',
      channelIdHex,
      description: classification.description,
      closeType: classification.closeType,
      initiator: classification.initiator,
      hasOnchainTx: classification.hasOnchainTx,
      fundingTxo,
      lastLocalBalanceSats,
    })

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
    // StaticOutputs paying to wallet-owned scripts need no sweep — our
    // SignerProvider routes destination scripts to BDK addresses, so those
    // funds are already on-chain in the wallet. Worse, KeysManager cannot
    // sign them, so persisting one would poison the all-or-nothing sweep
    // batch forever (`ldk-sign`). The check never throws; on doubt the
    // descriptor is kept, which is the fund-safe direction.
    const sweepable = event.outputs.filter((o) => !isWalletOwnedStaticOutput(o, bdkWallet))
    const alreadyInWallet = event.outputs.length - sweepable.length
    if (alreadyInWallet > 0) {
      console.log(
        '[LDK Event] SpendableOutputs:',
        alreadyInWallet,
        'output(s) already pay to the on-chain wallet; no sweep needed'
      )
    }
    // Drain everything synchronously: serialized descriptors, the source
    // channel (Option — may be NULL/all-0s), and each output's outpoint +
    // value. Sweep attribution is by these facts, never by causality
    // (batching + the sweep-in-progress guard make "the sweep my event
    // triggered" nondeterministic).
    // Attribution extraction is guarded PER OUTPUT: a throwing binding
    // accessor here must never abort this block — handle_event's top-level
    // catch would return ok() and LDK would never replay the event, so the
    // descriptors (the fund-safety payload) would be lost unswept forever.
    // Attribution is cosmetic; it degrades to empty.
    const outpoints: SpendableOutputsEntry['outpoints'] = []
    for (const o of sweepable) {
      try {
        const outpoint = o.spendable_outpoint()
        outpoints.push({
          txid: txidBytesToHex(outpoint.get_txid()),
          vout: outpoint.get_index(),
          valueSats: readDescriptorValueSats(o).toString(),
        })
      } catch (err: unknown) {
        console.warn('[LDK Event] SpendableOutputs: outpoint extraction failed:', err)
      }
    }
    const entry: SpendableOutputsEntry = {
      descriptors: sweepable.map((o) => o.write()),
      channelIdHex: readOptionalChannelIdHex(event.channel_id),
      outpoints,
    }
    // Even when nothing new needs persisting, still run the sweep — older
    // pending entries may be waiting on retry.
    const persisted =
      sweepable.length > 0 ? idbPut('ldk_spendable_outputs', key, entry) : Promise.resolve()
    void persisted
      .then(() => {
        const destinationScript = revealNextAddress(bdkWallet, 'LDK Event')
        return sweepSpendableOutputs({
          keysManager,
          bdkWallet,
          destinationScript,
          esploraUrl: ONCHAIN_CONFIG.esploraUrl,
          esploraFallbackUrl: LDK_CONFIG.esploraFallbackUrl,
          reserveSats: anchorReserveSats(channelManager),
        })
      })
      .then((result) => {
        if (result && result.swept > 0) {
          recordSweepResult(result)
          console.log(
            '[LDK Event] SpendableOutputs: swept',
            result.swept,
            'output(s), txid(s):',
            result.txs.map((t) => t.txid).join(', ')
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
      sweepable.length,
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
    const bumpEvent = event.bump_transaction
    // Extract channel ID from the bump event for recovery context lookup
    let bumpChannelIdHex: string | null = null
    if (bumpEvent instanceof BumpTransactionEvent_ChannelClose) {
      bumpChannelIdHex = bytesToHex(bumpEvent.channel_id.write())
    } else if (bumpEvent instanceof BumpTransactionEvent_HTLCResolution) {
      bumpChannelIdHex = bytesToHex(bumpEvent.channel_id.write())
    }
    // Close-record sync read model (replaces the old memory-only
    // forceCloseInfoMap, which lost recovery context on event replay after
    // a reload — records are loaded from IDB before the event processor
    // starts, so replays still find their context here).
    const closeRecord = bumpChannelIdHex ? getCloseRecordSync(bumpChannelIdHex) : undefined
    const recoveryContext = bumpChannelIdHex
      ? {
          channelId: bumpChannelIdHex,
          // Null (not 0) when the close record is missing or predates the
          // balance fact — the UI renders "Unknown" instead of a false ₿0.
          localBalanceSat:
            closeRecord?.expectedAmountSats !== undefined
              ? Number(closeRecord.expectedAmountSats)
              : null,
        }
      : null

    // Attach the commitment txid + pre-committed fee to the close record.
    // Only the anchor path hands us the actual commitment transaction.
    if (bumpEvent instanceof BumpTransactionEvent_ChannelClose && bumpChannelIdHex) {
      try {
        const txid = Transaction.from_bytes(bumpEvent.commitment_tx).compute_txid().toString()
        handleCloseSignal({
          type: 'commitment_broadcast',
          channelIdHex: bumpChannelIdHex,
          txid,
          feeSats: bumpEvent.commitment_tx_fee_satoshis,
        })
      } catch (err: unknown) {
        captureError(
          'warning',
          'Event:BumpTransaction',
          'Failed to extract commitment txid',
          String(err)
        )
      }
    }

    if (bumpTxHandler) {
      // Pre-check: does the wallet have confirmed UTXOs for CPFP?
      // BumpTransactionEventHandler.handle_event() fails silently in WASM
      // (logs internally but does not throw), so the try/catch below never
      // fires. Detect the no-UTXO case before calling into WASM so we can
      // surface recovery guidance to the user.
      let hasConfirmedUtxo = false
      try {
        const unspent = bdkWallet.list_unspent()
        hasConfirmedUtxo = unspent.some((output) => {
          const wtx = bdkWallet.get_tx(output.outpoint.txid)
          return wtx != null && wtx.chain_position.is_confirmed
        })
      } catch {
        // Best-effort check — proceed to handler regardless
      }

      // Fire even when the close record is missing (degraded info beats
      // silently skipping recovery signaling — the old `&& forceCloseInfo`
      // guard dropped it entirely on replay after a reload). But NOT before
      // the initial BDK scan: on a restore the wallet is empty by
      // construction until the scan lands, so "no UTXOs" is meaningless and
      // this fired a false Recover Funds banner on every restore. A genuinely
      // stuck close re-triggers after the scan — LDK re-yields bump events on
      // each new block until the claim confirms.
      if (!hasConfirmedUtxo && onRecoveryNeeded && recoveryContext) {
        if (isInitialScanComplete()) {
          onRecoveryNeeded({
            ...recoveryContext,
            reason:
              'No confirmed on-chain UTXOs available for CPFP fee bump — deposit funds to complete force-close recovery',
          })
        } else {
          console.log(
            '[LDK Event] BumpTransaction: no UTXOs but initial scan pending — deferring recovery signal'
          )
        }
      }

      console.log('[LDK Event] BumpTransaction: handling CPFP fee bump')
      try {
        bumpTxHandler.handle_event(bumpEvent)
      } catch (err: unknown) {
        captureError('critical', 'Event:BumpTransaction', 'CPFP handling failed', String(err))
        if (onRecoveryNeeded && recoveryContext) {
          onRecoveryNeeded({ ...recoveryContext, reason: String(err) })
        }
      }
    } else {
      captureError(
        'critical',
        'Event:BumpTransaction',
        'No handler configured — force-close tx may be stuck'
      )
      if (onRecoveryNeeded && recoveryContext) {
        onRecoveryNeeded({
          ...recoveryContext,
          reason: 'No BumpTransactionEventHandler configured',
        })
      }
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

    if (isTrustedLsp(counterpartyHex)) {
      // Generate user_channel_id with 8 random bytes (not 16) to avoid u128 encoding bug
      // See learnings: ldk-wasm-encode-uint128-asymmetry
      const randomBytes = new Uint8Array(8)
      crypto.getRandomValues(randomBytes)
      const userChannelId = randomBytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n)
      const result = channelManager.accept_inbound_channel_from_trusted_peer_0conf(
        event.temporary_channel_id,
        event.counterparty_node_id,
        userChannelId,
        buildJitChannelConfigOverrides()
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
      `HTLCHandlingFailed: prevChannelId: ${bytesToHex(event.prev_channel_id.write())} failureType: ${event.failure_type.constructor.name}`
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

/**
 * Read an Option-like ChannelId: the bindings represent None as NULL or an
 * all-zero id (see the Event_SpendableOutputs docs in the .d.mts).
 */
function readOptionalChannelIdHex(channelId: { write(): Uint8Array } | null): string | null {
  try {
    if (!channelId) return null
    const hex = bytesToHex(channelId.write())
    return /^0*$/.test(hex) ? null : hex
  } catch {
    return null
  }
}

/** Best-effort output value per descriptor variant; 0 when unavailable. */
function readDescriptorValueSats(descriptor: SpendableOutputDescriptor): bigint {
  try {
    if (descriptor instanceof SpendableOutputDescriptor_StaticOutput) {
      return descriptor.output.value
    }
    if (descriptor instanceof SpendableOutputDescriptor_DelayedPaymentOutput) {
      return descriptor.delayed_payment_output.get_output().value
    }
    if (descriptor instanceof SpendableOutputDescriptor_StaticPaymentOutput) {
      return descriptor.static_payment_output.get_output().value
    }
  } catch {
    // fall through
  }
  return 0n
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
