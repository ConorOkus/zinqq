import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import {
  UtilMethods,
  Retry,
  Option_u64Z,
  Option_u64Z_Some,
  Option_u64Z_None,
  Option_u16Z_None,
  Option_StrZ,
  Result_C2Tuple_ThirtyTwoBytesThirtyTwoBytesZNoneZ_OK,
  Result_C3Tuple_ThirtyTwoBytesRecipientOnionFieldsRouteParametersZNoneZ_OK,
  Result_Bolt11InvoiceSignOrCreationErrorZ_OK,
  Result_OfferWithDerivedMetadataBuilderBolt12SemanticErrorZ_OK,
  Result_OfferBolt12SemanticErrorZ_OK,
  type ChannelId,
  type Bolt11Invoice,
  type Offer,
} from 'lightningdevkit'
import { initializeLdk, type LdkNode } from './init'
import { VssClient, SignatureHeaderProvider } from './storage/vss-client'
import {
  LdkContext,
  defaultLdkContextValue,
  type LdkContextValue,
  type PaymentResult,
} from './ldk-context'
import { LDK_CONFIG } from './config'
import { EsploraClient } from './sync/esplora-client'
import { startSyncLoop } from './sync/chain-sync'
import { connectToPeer as doConnectToPeer, type PeerConnection } from './peers/peer-connection'
import { reconnectDisconnectedPeers } from './peers/peer-reconnect'
import { idbPut } from '../storage/idb'
import { persistChannelManager, persistChannelManagerIdbOnly } from './storage/persist-cm'
import { getKnownPeers, putKnownPeer, deleteKnownPeer } from './storage/known-peers'
import { getPersistedOffer, putPersistedOffer } from './storage/offer'
import { persistPayment, loadAllPayments } from './storage/payment-history'
import { bytesToHex, hexToBytes } from './utils'
import { msatToSatFloor } from '../utils/msat'
import { captureError } from '../storage/error-log'
import { selectCheapestParams, calculateOpeningFee, type JitInvoiceResult } from './lsps2/types'

function getOutboundCapacitySats(cm: import('lightningdevkit').ChannelManager): bigint {
  const msat = cm
    .list_usable_channels()
    .reduce((sum, ch) => sum + ch.get_outbound_capacity_msat(), 0n)
  return msatToSatFloor(msat)
}

export function LdkProvider({
  children,
  ldkSeed,
  bdkDescriptors,
  vssEncryptionKey,
  vssSigningKey,
  vssStoreId,
}: {
  children: ReactNode
  ldkSeed: Uint8Array
  bdkDescriptors: { external: string; internal: string }
  vssEncryptionKey: Uint8Array
  vssSigningKey: Uint8Array
  vssStoreId: string
}) {
  const [state, setState] = useState<LdkContextValue>(defaultLdkContextValue)
  const nodeRef = useRef<LdkNode | null>(null)
  const lightningBalanceSatsRef = useRef(0n)
  const channelChangeCounterRef = useRef(0)
  const lastChannelSnapshotRef = useRef('')
  const activeConnections = useRef<Map<string, PeerConnection>>(new Map())
  // Mutable ref holding the teardown function for the running LDK node.
  // Called by the Restore flow to stop all background persistence before clearing IDB.
  const teardownRef = useRef<(() => void) | null>(null)
  // Mutable ref for the event-drain + UI-refresh function. Called from the
  // WebSocket onmessage callback so the UI updates immediately on peer messages.
  const drainEventsRef = useRef<(() => void) | null>(null)

  const shutdown = useCallback(() => {
    console.log('[LDK Context] Shutting down LDK node for restore')
    teardownRef.current?.()
  }, [])

  const refreshPaymentHistory = useCallback(async () => {
    const all = await loadAllPayments()
    const payments = Array.from(all.values())
    setState((prev) => (prev.status === 'ready' ? { ...prev, paymentHistory: payments } : prev))
  }, [])

  const connectToPeer = useCallback(
    async (pubkey: string, host: string, port: number): Promise<void> => {
      if (!nodeRef.current) throw new Error('Node not initialized')
      const conn = await doConnectToPeer(nodeRef.current.peerManager, pubkey, host, port, () =>
        drainEventsRef.current?.()
      )
      activeConnections.current.get(pubkey)?.disconnect()
      activeConnections.current.set(pubkey, conn)
      putKnownPeer(pubkey, host, port).catch((err: unknown) =>
        captureError('warning', 'LDK', 'Failed to persist known peer', String(err))
      )
    },
    []
  )

  const createChannel = useCallback(
    (counterpartyPubkey: Uint8Array, channelValueSats: bigint): boolean => {
      if (!nodeRef.current) throw new Error('Node not initialized')
      // Generate a random user channel ID (u128). Use 8 random bytes (64 bits)
      // which is well within LDK's u128 limit while providing sufficient uniqueness.
      const idBytes = new Uint8Array(8)
      crypto.getRandomValues(idBytes)
      const userChannelId = idBytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n)
      const result = nodeRef.current.channelManager.create_channel(
        counterpartyPubkey,
        channelValueSats,
        0n, // push_msat
        userChannelId,
        null, // temporary_channel_id — let LDK generate
        null // override_config — use defaults
      )
      if (!result.is_ok()) {
        captureError('error', 'LDK', 'create_channel failed')
        return false
      }
      console.log('[ldk] create_channel succeeded for', channelValueSats.toString(), 'sats')
      return true
    },
    []
  )

  const closeChannel = useCallback(
    (channelId: ChannelId, counterpartyNodeId: Uint8Array): boolean => {
      if (!nodeRef.current) throw new Error('Node not initialized')
      const result = nodeRef.current.channelManager.close_channel(channelId, counterpartyNodeId)
      if (!result.is_ok()) {
        captureError('error', 'LDK', 'close_channel failed')
        return false
      }
      console.log('[ldk] close_channel initiated')
      return true
    },
    []
  )

  const forceCloseChannel = useCallback(
    (channelId: ChannelId, counterpartyNodeId: Uint8Array): boolean => {
      if (!nodeRef.current) throw new Error('Node not initialized')
      const result = nodeRef.current.channelManager.force_close_broadcasting_latest_txn(
        channelId,
        counterpartyNodeId,
        'User-initiated force close'
      )
      if (!result.is_ok()) {
        captureError('critical', 'LDK', 'force_close failed')
        return false
      }
      console.log('[ldk] force_close initiated')
      return true
    },
    []
  )

  const listChannels = useCallback(() => {
    const node = nodeRef.current
    if (!node) return []
    return node.channelManager.list_channels()
  }, [])

  const forgetPeer = useCallback(async (pubkey: string): Promise<void> => {
    const node = nodeRef.current
    if (!node) throw new Error('Node not initialized')

    const channels = node.channelManager.list_channels()
    const hasChannels = channels.some((ch) => {
      const counterparty = bytesToHex(ch.get_counterparty().get_node_id())
      return counterparty === pubkey
    })

    if (hasChannels) {
      throw new Error('Cannot forget peer with open channels')
    }

    await deleteKnownPeer(pubkey)
  }, [])

  // Payment result store: tracks outcomes of in-flight payments.
  // Bounded to 100 entries to prevent unbounded memory growth.
  const MAX_PAYMENT_RESULTS = 100
  const paymentResultsRef = useRef(new Map<string, PaymentResult>())
  const setPaymentResult = (key: string, value: PaymentResult) => {
    const map = paymentResultsRef.current
    if (map.size >= MAX_PAYMENT_RESULTS) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
    map.set(key, value)
  }

  const createInvoice = useCallback(
    (
      amountMsat?: bigint,
      description = 'Zinqq Wallet'
    ): { bolt11: string; paymentHash: string } => {
      const node = nodeRef.current
      if (!node) throw new Error('Node not initialized')

      const amountOption =
        amountMsat != null
          ? Option_u64Z.constructor_some(amountMsat)
          : Option_u64Z_None.constructor_none()

      const result = UtilMethods.constructor_create_invoice_from_channelmanager(
        node.channelManager,
        amountOption,
        description,
        3600, // 1 hour expiry
        Option_u16Z_None.constructor_none()
      )

      if (!(result instanceof Result_Bolt11InvoiceSignOrCreationErrorZ_OK)) {
        console.error('[ldk] create_invoice failed:', result)
        throw new Error('Failed to create invoice')
      }

      const invoice = result.res
      return {
        bolt11: invoice.to_str(),
        paymentHash: bytesToHex(invoice.payment_hash()),
      }
    },
    []
  )

  const requestJitInvoice = useCallback(
    async (amountMsat: bigint, description: string): Promise<JitInvoiceResult> => {
      const node = nodeRef.current
      if (!node) throw new Error('Node not initialized')

      const lspNodeId = LDK_CONFIG.lspNodeId
      if (!lspNodeId) throw new Error('LSP not configured')

      // Ensure LSP is connected
      const lspHost = LDK_CONFIG.lspHost
      const lspPort = LDK_CONFIG.lspPort
      if (lspHost) {
        try {
          const conn = await doConnectToPeer(node.peerManager, lspNodeId, lspHost, lspPort, () =>
            drainEventsRef.current?.()
          )
          activeConnections.current.get(lspNodeId)?.disconnect()
          activeConnections.current.set(lspNodeId, conn)
        } catch {
          // May already be connected, continue
        }
      }

      // Step 1: Get opening fee params from LSP
      const feeMenu = await node.lsps2Client.getOpeningFeeParams(lspNodeId, LDK_CONFIG.lspToken)

      // Step 2: Select cheapest valid params
      const selectedParams = selectCheapestParams(feeMenu, amountMsat)
      if (!selectedParams) {
        throw new Error('No suitable fee parameters available for this amount')
      }

      // Validate valid_until with 120s buffer for clock skew + network latency
      if (new Date(selectedParams.validUntil).getTime() < Date.now() + 120_000) {
        throw new Error('Fee parameters expiring too soon, please try again')
      }

      // Step 3: Buy JIT channel
      const buyResponse = await node.lsps2Client.buyChannel(lspNodeId, selectedParams, amountMsat)

      // Step 4: Register payment with LDK
      // The LSP deducts the opening fee before forwarding, so the received amount
      // will be less than the invoice amount. Pass the expected post-fee amount
      // so LDK rejects grossly underpaid HTLCs while allowing the fee deduction.
      const openingFeeMsat = calculateOpeningFee(amountMsat, selectedParams)
      const expectedReceiveMsat = amountMsat - openingFeeMsat
      const paymentResult = node.channelManager.create_inbound_payment(
        Option_u64Z.constructor_some(expectedReceiveMsat),
        3600, // 1 hour expiry
        Option_u16Z_None.constructor_none()
      )
      if (!(paymentResult instanceof Result_C2Tuple_ThirtyTwoBytesThirtyTwoBytesZNoneZ_OK)) {
        throw new Error('Failed to create inbound payment')
      }
      const paymentHash = paymentResult.res.get_a()
      const paymentSecret = paymentResult.res.get_b()

      // Step 5: Build and sign the BOLT11 invoice with JIT route hint
      const nodeIdBytes = hexToBytes(node.nodeId)
      const bolt11 = await node.lsps2Client.createJitInvoice({
        buyResponse,
        lspNodeId,
        amountMsat,
        description,
        nodeId: nodeIdBytes,
        nodeSecretKey: node.nodeSecretKey,
        paymentHash,
        paymentSecret,
        minFinalCltvExpiry: 144,
      })

      return { bolt11, openingFeeMsat, paymentHash: bytesToHex(paymentHash) }
    },
    []
  )

  const sendBolt11Payment = useCallback(
    (invoice: Bolt11Invoice, amountMsat?: bigint): Uint8Array => {
      const node = nodeRef.current
      if (!node) throw new Error('Node not initialized')

      const hasAmount = invoice.amount_milli_satoshis() instanceof Option_u64Z_Some
      if (!hasAmount && amountMsat == null) {
        throw new Error('Amount is required for invoices without an embedded amount')
      }
      const paramsResult = hasAmount
        ? UtilMethods.constructor_payment_parameters_from_invoice(invoice)
        : UtilMethods.constructor_payment_parameters_from_variable_amount_invoice(
            invoice,
            amountMsat as bigint
          )

      if (
        !(
          paramsResult instanceof
          Result_C3Tuple_ThirtyTwoBytesRecipientOnionFieldsRouteParametersZNoneZ_OK
        )
      ) {
        throw new Error('Failed to extract payment parameters from invoice')
      }

      const paymentHash = paramsResult.res.get_a()
      const recipientOnion = paramsResult.res.get_b()
      const routeParams = paramsResult.res.get_c()
      const paymentId = paymentHash // use payment hash as ID (guaranteed unique per invoice)

      const result = node.channelManager.send_payment(
        paymentHash,
        recipientOnion,
        paymentId,
        routeParams,
        Retry.constructor_attempts(3)
      )

      if (!result.is_ok()) {
        throw new Error('Payment routing failed — no route found or duplicate payment')
      }

      const paymentIdHex = bytesToHex(paymentId)
      setPaymentResult(paymentIdHex, { status: 'pending' })

      const invoiceAmountOpt = invoice.amount_milli_satoshis()
      const resolvedMsat =
        invoiceAmountOpt instanceof Option_u64Z_Some ? invoiceAmountOpt.some : (amountMsat ?? 0n)
      void persistPayment({
        paymentHash: paymentIdHex,
        direction: 'outbound',
        amountMsat: resolvedMsat,
        status: 'pending',
        feePaidMsat: null,
        createdAt: Date.now(),
        failureReason: null,
      }).then(() => void refreshPaymentHistory())

      return paymentId
    },
    [refreshPaymentHistory]
  )

  const sendBolt12Payment = useCallback(
    (offer: Offer, amountMsat?: bigint, payerNote?: string): Uint8Array => {
      const node = nodeRef.current
      if (!node) throw new Error('Node not initialized')

      // Use 8 random bytes for payment ID (safe u128 range per institutional learning)
      const paymentId = crypto.getRandomValues(new Uint8Array(32))

      const result = node.channelManager.pay_for_offer(
        offer,
        Option_u64Z.constructor_none(), // quantity
        amountMsat != null
          ? Option_u64Z.constructor_some(amountMsat)
          : Option_u64Z.constructor_none(),
        payerNote ? Option_StrZ.constructor_some(payerNote) : Option_StrZ.constructor_none(),
        paymentId,
        Retry.constructor_attempts(3),
        Option_u64Z.constructor_none() // max routing fee
      )

      if (!result.is_ok()) {
        throw new Error('Failed to initiate offer payment')
      }

      const paymentIdHex = bytesToHex(paymentId)
      setPaymentResult(paymentIdHex, { status: 'pending' })

      void persistPayment({
        paymentHash: paymentIdHex,
        direction: 'outbound',
        amountMsat: amountMsat ?? 0n,
        status: 'pending',
        feePaidMsat: null,
        createdAt: Date.now(),
        failureReason: null,
      }).then(() => void refreshPaymentHistory())

      return paymentId
    },
    [refreshPaymentHistory]
  )

  const abandonPayment = useCallback((paymentId: Uint8Array): void => {
    const node = nodeRef.current
    if (!node) throw new Error('Node not initialized')
    node.channelManager.abandon_payment(paymentId)
  }, [])

  const getPaymentResult = useCallback((paymentId: Uint8Array): PaymentResult | null => {
    return paymentResultsRef.current.get(bytesToHex(paymentId)) ?? null
  }, [])

  const listRecentPayments = useCallback(() => {
    const node = nodeRef.current
    if (!node) return []
    return node.channelManager.list_recent_payments()
  }, [])

  const outboundCapacityMsat = useCallback((): bigint => {
    const node = nodeRef.current
    if (!node) return 0n
    return node.channelManager
      .list_usable_channels()
      .reduce((sum, ch) => sum + ch.get_outbound_capacity_msat(), 0n)
  }, [])

  useEffect(() => {
    let cancelled = false
    let syncHandle: { stop: () => void } | null = null
    let peerTimerId: ReturnType<typeof setInterval> | null = null
    let cleanupEventHandlerFn: (() => void) | null = null
    let offerRetryTimer: ReturnType<typeof setTimeout> | null = null

    const vssDisabled = import.meta.env.VITE_DISABLE_VSS === 'true'
    const vssAuth = vssDisabled ? null : new SignatureHeaderProvider(vssSigningKey)
    const vssClient = vssDisabled
      ? null
      : new VssClient(LDK_CONFIG.vssUrl, vssStoreId, vssEncryptionKey, vssAuth!)

    initializeLdk({
      ldkSeed,
      bdkDescriptors,
      vssClient,
      persisterOptions: {
        vssClient,
        onVssUnavailable: () => {
          setState((prev) => (prev.status === 'ready' ? { ...prev, vssStatus: 'degraded' } : prev))
        },
        onVssRecovered: () => {
          setState((prev) => (prev.status === 'ready' ? { ...prev, vssStatus: 'ok' } : prev))
        },
      },
    })
      .then(
        async ({
          node,
          watchState,
          cleanupEventHandler,
          bdkWallet,
          bdkEsploraClient,
          setPaymentCallback,
          setChannelClosedCallback,
          setSyncNeededCallback,
          setConnectionNeededCallback,
          cmPersistCtx,
        }) => {
          if (cancelled) return

          nodeRef.current = node

          // Expose node on window for dev console debugging (exclude secret key)
          if (import.meta.env.DEV) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { nodeSecretKey: _secret, ...safeNode } = node
            ;(window as unknown as Record<string, unknown>).__ldkNode = safeNode
          }

          // Zero secret keys on page unload to limit memory exposure
          const zeroSecretOnUnload = () => {
            node.nodeSecretKey.fill(0)
            vssAuth?.destroy()
          }
          window.addEventListener('beforeunload', zeroSecretOnUnload)

          // Wire payment event callback to update the result store and refresh history
          setPaymentCallback((event) => {
            if (event.type === 'sent') {
              setPaymentResult(event.paymentHash, {
                status: 'sent',
                preimage: event.preimage,
                feePaidMsat: event.feePaidMsat,
              })
            } else if (event.type === 'failed') {
              setPaymentResult(event.paymentHash, {
                status: 'failed',
                reason: event.reason,
              })
            }
            void refreshPaymentHistory()
          })

          // Remove peer from known peers when their last channel closes,
          // so auto-reconnect doesn't trigger stale "wrong node" warnings.
          setChannelClosedCallback((counterpartyPubkeyHex) => {
            deleteKnownPeer(counterpartyPubkeyHex).catch((err: unknown) => {
              captureError(
                'warning',
                'LDK',
                'Failed to remove known peer after channel close',
                String(err)
              )
            })
          })

          // Reconnect peers when LDK signals ConnectionNeeded (e.g., pending
          // HTLCs require the peer to be online). Uses addresses from the event.
          setConnectionNeededCallback((nodeIdHex, host, port) => {
            void doConnectToPeer(node.peerManager, nodeIdHex, host, port, () =>
              drainEventsRef.current?.()
            )
              .then((conn) => {
                activeConnections.current.get(nodeIdHex)?.disconnect()
                activeConnections.current.set(nodeIdHex, conn)
              })
              .catch((err: unknown) => {
                captureError(
                  'warning',
                  'LDK',
                  `ConnectionNeeded reconnect failed: ${nodeIdHex.substring(0, 16)}…`,
                  String(err)
                )
              })
          })

          cleanupEventHandlerFn = cleanupEventHandler

          const esplora = new EsploraClient(LDK_CONFIG.esploraUrl)
          const confirmables = [node.channelManager.as_Confirm(), node.chainMonitor.as_Confirm()]

          syncHandle = startSyncLoop({
            confirmables,
            watchState,
            esplora,
            channelManager: node.channelManager,
            chainMonitor: node.chainMonitor,
            networkGraph: node.networkGraph,
            logger: node.logger,
            scorer: node.scorer,
            intervalMs: LDK_CONFIG.chainPollIntervalMs,
            rgsUrl: LDK_CONFIG.rgsUrl,
            rgsSyncIntervalTicks: LDK_CONFIG.rgsSyncIntervalTicks,
            onStatusChange: (syncStatus) => {
              setState((prev) => (prev.status === 'ready' ? { ...prev, syncStatus } : prev))
            },
            cmPersistCtx,
          })

          // Periodic reconnection: check every 3rd tick (~30s) for channel
          // peers that have dropped and reconnect them from known peers.
          let peerTickCount = 0
          let reconnecting = false

          const maybeReconnectPeers = () => {
            if (reconnecting) return
            reconnecting = true
            reconnectDisconnectedPeers(
              node.channelManager,
              node.peerManager,
              activeConnections.current,
              () => drainEventsRef.current?.()
            )
              .catch((err: unknown) => {
                console.warn('[ldk] peer reconnect failed:', err)
              })
              .finally(() => {
                reconnecting = false
              })
          }

          // Drain LDK events and refresh UI state. Called from both the 10s
          // timer and the per-message WebSocket callback so the UI updates
          // immediately when channel state changes (e.g., channel_ready).
          function drainEventsAndRefresh() {
            node.channelManager.as_EventsProvider().process_pending_events(node.eventHandler)
            node.chainMonitor.as_EventsProvider().process_pending_events(node.eventHandler)
            node.onionMessenger.as_EventsProvider().process_pending_events(node.eventHandler)

            // Recompute Lightning balance and update context if changed
            const newBalanceSats = getOutboundCapacitySats(node.channelManager)
            const balanceChanged = newBalanceSats !== lightningBalanceSatsRef.current

            // Detect channel state changes (count, ready, usable status)
            const channels = node.channelManager.list_channels()
            const snapshot = channels
              .map(
                (ch) =>
                  `${bytesToHex(ch.get_channel_id().write())}:${ch.get_is_channel_ready()}:${ch.get_is_usable()}`
              )
              .sort()
              .join(',')
            const channelsChanged = snapshot !== lastChannelSnapshotRef.current
            lastChannelSnapshotRef.current = snapshot

            if (balanceChanged || channelsChanged) {
              lightningBalanceSatsRef.current = newBalanceSats
              if (channelsChanged) channelChangeCounterRef.current += 1
              const newCounter = channelChangeCounterRef.current
              setState((prev) =>
                prev.status === 'ready'
                  ? {
                      ...prev,
                      lightningBalanceSats: newBalanceSats,
                      channelChangeCounter: newCounter,
                    }
                  : prev
              )
            }

            // Flush ChannelManager state immediately after processing events
            if (node.channelManager.get_and_clear_needs_persistence()) {
              void persistChannelManager(node.channelManager, cmPersistCtx).catch(
                (err: unknown) => {
                  captureError(
                    'critical',
                    'LDK Context',
                    'Failed to persist ChannelManager after events',
                    String(err)
                  )
                }
              )
            }
          }

          // Coalesce rapid WebSocket messages into a single drain per
          // microtask to avoid excessive recomputation from chatty peers.
          let drainScheduled = false
          drainEventsRef.current = () => {
            if (drainScheduled) return
            drainScheduled = true
            queueMicrotask(() => {
              drainScheduled = false
              drainEventsAndRefresh()
            })
          }

          // PeerManager timer + LDK event processing every ~10s
          peerTimerId = setInterval(() => {
            node.peerManager.timer_tick_occurred()
            node.peerManager.process_events()

            // Check for disconnected channel peers every ~30s
            peerTickCount += 1
            if (peerTickCount % 3 === 0) {
              maybeReconnectPeers()
            }

            drainEventsAndRefresh()
          }, LDK_CONFIG.peerTimerIntervalMs)

          // Compute initial Lightning balance eagerly so Home screen
          // does not show 0 for up to 10s before the first timer tick.
          const initialBalanceSats = getOutboundCapacitySats(node.channelManager)
          lightningBalanceSatsRef.current = initialBalanceSats

          // Load persisted Lightning payment history
          const initialPayments = await loadAllPayments()
          const initialPaymentHistory = Array.from(initialPayments.values())

          setState({
            status: 'ready',
            node,
            nodeId: node.nodeId,
            error: null,
            syncStatus: 'syncing',
            connectToPeer,
            forgetPeer,
            createChannel,
            closeChannel,
            forceCloseChannel,
            listChannels,
            bdkWallet,
            bdkEsploraClient,
            setSyncNeeded: setSyncNeededCallback,
            createInvoice,
            requestJitInvoice,
            sendBolt11Payment,
            sendBolt12Payment,
            abandonPayment,
            getPaymentResult,
            listRecentPayments,
            outboundCapacityMsat,
            lightningBalanceSats: initialBalanceSats,
            channelChangeCounter: 0,
            peersReconnected: false,
            paymentHistory: initialPaymentHistory,
            bolt12Offer: null,
            vssStatus: 'ok',
            shutdown,
          })

          // Load or create the BOLT 12 offer after peers reconnect.
          // Retries with backoff because create_offer_builder needs the
          // DefaultMessageRouter to find blinding paths through the network
          // graph, which may not be populated until RGS sync completes.
          const MAX_OFFER_RETRIES = 5
          let offerCreationStarted = false
          const loadOrCreateOffer = async (attempt = 0) => {
            if (cancelled) return
            if (attempt === 0) {
              if (offerCreationStarted) return
              offerCreationStarted = true
            }
            try {
              const existing = attempt === 0 ? await getPersistedOffer() : undefined
              if (existing) {
                setState((prev) =>
                  prev.status === 'ready' ? { ...prev, bolt12Offer: existing } : prev
                )
                return
              }

              const builderResult = node.channelManager.create_offer_builder(
                Option_u64Z.constructor_none() // no expiry
              )
              if (
                !(
                  builderResult instanceof
                  Result_OfferWithDerivedMetadataBuilderBolt12SemanticErrorZ_OK
                )
              ) {
                if (attempt < MAX_OFFER_RETRIES) {
                  const delayMs = 3000 * 2 ** attempt // 3s, 6s, 12s, 24s, 48s
                  captureError(
                    'warning',
                    'LDK',
                    `create_offer_builder failed (attempt ${attempt + 1}/${MAX_OFFER_RETRIES + 1}), retrying in ${delayMs / 1000}s`
                  )
                  offerRetryTimer = setTimeout(() => void loadOrCreateOffer(attempt + 1), delayMs)
                  return
                }
                captureError('error', 'LDK', 'create_offer_builder failed after retries')
                return
              }
              const builder = builderResult.res
              builder.chain(LDK_CONFIG.network)
              builder.description('zinqq wallet')
              const offerResult = builder.build()
              if (!(offerResult instanceof Result_OfferBolt12SemanticErrorZ_OK)) {
                captureError('error', 'LDK', 'offer build failed')
                return
              }
              const offerStr = offerResult.res.to_str()
              await putPersistedOffer(offerStr)
              setState((prev) =>
                prev.status === 'ready' ? { ...prev, bolt12Offer: offerStr } : prev
              )
              console.log('[ldk] BOLT 12 offer created and persisted')
            } catch (err) {
              captureError('error', 'LDK', 'Failed to load/create BOLT 12 offer', String(err))
            }
          }

          // Auto-connect to LSP so JIT channels are ready when needed
          if (LDK_CONFIG.lspNodeId && LDK_CONFIG.lspHost) {
            void doConnectToPeer(
              node.peerManager,
              LDK_CONFIG.lspNodeId,
              LDK_CONFIG.lspHost,
              LDK_CONFIG.lspPort,
              () => drainEventsRef.current?.()
            )
              .then((conn) => {
                activeConnections.current.set(LDK_CONFIG.lspNodeId, conn)
                console.log('[ldk] Connected to LSP')
              })
              .catch((err: unknown) => {
                captureError(
                  'warning',
                  'LDK',
                  'LSP auto-connect failed (will retry on receive)',
                  String(err)
                )
              })
          }

          // Auto-reconnect to known peers, then mark peersReconnected so
          // the Home screen knows the lightning balance is now accurate.
          getKnownPeers()
            .then(async (peers) => {
              if (peers.size === 0) {
                setState((prev) =>
                  prev.status === 'ready' ? { ...prev, peersReconnected: true } : prev
                )
                void loadOrCreateOffer()
                return
              }
              console.log(`[ldk] reconnecting to ${peers.size} known peer(s)`)
              const results = await Promise.allSettled(
                Array.from(peers.entries()).map(async ([pubkey, { host, port }]) => {
                  const conn = await doConnectToPeer(node.peerManager, pubkey, host, port, () =>
                    drainEventsRef.current?.()
                  )
                  activeConnections.current.set(pubkey, conn)
                })
              )
              const succeeded = results.filter((r) => r.status === 'fulfilled').length
              const failed = results.filter((r) => r.status === 'rejected').length
              console.log(`[ldk] peer reconnection: ${succeeded} connected, ${failed} failed`)

              // Wait for channels to become usable after reconnection.
              // connectToPeer resolves after the noise handshake, but LDK still
              // needs to exchange channel_reestablish messages before channels
              // are marked usable. Poll briefly (up to 5s) so the balance is
              // accurate before we dismiss the loading spinner.
              if (succeeded > 0) {
                for (let attempt = 0; attempt < 10; attempt++) {
                  await new Promise((resolve) => setTimeout(resolve, 500))
                  node.peerManager.process_events()
                  if (node.channelManager.list_usable_channels().length > 0) break
                }
              }

              const bal = getOutboundCapacitySats(node.channelManager)
              lightningBalanceSatsRef.current = bal
              setState((prev) =>
                prev.status === 'ready'
                  ? { ...prev, lightningBalanceSats: bal, peersReconnected: true }
                  : prev
              )
              void loadOrCreateOffer()
            })
            .catch((err: unknown) => {
              captureError('warning', 'LDK', 'Failed to read known peers', String(err))
              // Still mark as reconnected so UI doesn't stay loading forever
              setState((prev) =>
                prev.status === 'ready' ? { ...prev, peersReconnected: true } : prev
              )
              void loadOrCreateOffer()
            })
        }
      )
      .catch((err: unknown) => {
        if (cancelled) return
        setState({
          status: 'error',
          node: null,
          nodeId: null,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      })

    // Best-effort persist on tab hide (visibilitychange is more reliable than beforeunload)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && nodeRef.current) {
        const { channelManager, networkGraph, scorer } = nodeRef.current
        void Promise.all([
          persistChannelManagerIdbOnly(channelManager),
          idbPut('ldk_network_graph', 'primary', networkGraph.write()),
          idbPut('ldk_scorer', 'primary', scorer.write()),
        ]).catch((err: unknown) =>
          captureError('error', 'LDK', 'Visibility-change persist failed', String(err))
        )
      } else if (document.visibilityState === 'visible' && nodeRef.current) {
        // Drain events immediately on tab foreground to process any channel
        // opens or payments that arrived while backgrounded
        drainEventsRef.current?.()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    const connections = activeConnections.current
    const teardown = () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      syncHandle?.stop()
      cleanupEventHandlerFn?.()
      // Don't destroy LSPS handler or zero key here — React StrictMode
      // re-runs effects but the node is deduplicated via initPromise.
      // These cleanups happen in the node's own lifecycle (page unload).
      if (peerTimerId !== null) clearInterval(peerTimerId)
      if (offerRetryTimer !== null) clearTimeout(offerRetryTimer)
      for (const [, conn] of connections) {
        conn.disconnect()
      }
      connections.clear()
      nodeRef.current = null
      teardownRef.current = null
      drainEventsRef.current = null
    }
    teardownRef.current = teardown
    return teardown
  }, [
    connectToPeer,
    forgetPeer,
    createChannel,
    closeChannel,
    forceCloseChannel,
    listChannels,
    createInvoice,
    sendBolt11Payment,
    sendBolt12Payment,
    abandonPayment,
    getPaymentResult,
    listRecentPayments,
    outboundCapacityMsat,
    refreshPaymentHistory,
    shutdown,
    ldkSeed,
    bdkDescriptors,
    vssEncryptionKey,
    vssStoreId,
  ])

  return <LdkContext value={state}>{children}</LdkContext>
}
