import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import {
  UtilMethods,
  Retry,
  Option_u64Z,
  Option_u64Z_Some,
  Option_u64Z_None,
  Option_u16Z_None,
  Option_StrZ,
  Result_C3Tuple_ThirtyTwoBytesRecipientOnionFieldsRouteParametersZNoneZ_OK,
  Result_Bolt11InvoiceSignOrCreationErrorZ_OK,
  type ChannelId,
  type Bolt11Invoice,
  type Offer,
  type HumanReadableName,
} from 'lightningdevkit'
import { initializeLdk, type LdkNode } from './init'
import { LdkContext, defaultLdkContextValue, type LdkContextValue, type PaymentResult } from './ldk-context'
import { SIGNET_CONFIG } from './config'
import { EsploraClient } from './sync/esplora-client'
import { startSyncLoop } from './sync/chain-sync'
import { connectToPeer as doConnectToPeer, type PeerConnection } from './peers/peer-connection'
import { idbPut } from './storage/idb'
import { getKnownPeers, putKnownPeer, deleteKnownPeer } from './storage/known-peers'
import { persistPayment, loadAllPayments } from './storage/payment-history'
import { bytesToHex } from './utils'
import { msatToSatFloor } from '../utils/msat'

export function LdkProvider({
  children,
  ldkSeed,
}: {
  children: ReactNode
  ldkSeed: Uint8Array
}) {
  const [state, setState] = useState<LdkContextValue>(defaultLdkContextValue)
  const nodeRef = useRef<LdkNode | null>(null)
  const lightningBalanceSatsRef = useRef(0n)
  const channelChangeCounterRef = useRef(0)
  const lastChannelSnapshotRef = useRef('')
  const activeConnections = useRef<Map<string, PeerConnection>>(new Map())

  const refreshPaymentHistory = useCallback(async () => {
    const all = await loadAllPayments()
    const payments = Array.from(all.values())
    setState((prev) =>
      prev.status === 'ready' ? { ...prev, paymentHistory: payments } : prev,
    )
  }, [])

  const connectToPeer = useCallback(
    async (pubkey: string, host: string, port: number): Promise<void> => {
      if (!nodeRef.current) throw new Error('Node not initialized')
      const conn = await doConnectToPeer(nodeRef.current.peerManager, pubkey, host, port)
      activeConnections.current.get(pubkey)?.disconnect()
      activeConnections.current.set(pubkey, conn)
      putKnownPeer(pubkey, host, port).catch((err: unknown) =>
        console.warn('[ldk] failed to persist known peer:', err)
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
      const userChannelId = idBytes.reduce(
        (acc, byte) => (acc << 8n) | BigInt(byte),
        0n,
      )
      const result = nodeRef.current.channelManager.create_channel(
        counterpartyPubkey,
        channelValueSats,
        0n, // push_msat
        userChannelId,
        null, // temporary_channel_id — let LDK generate
        null, // override_config — use defaults
      )
      if (!result.is_ok()) {
        console.error('[ldk] create_channel failed:', result)
        return false
      }
      console.log(
        '[ldk] create_channel succeeded for',
        channelValueSats.toString(),
        'sats',
      )
      return true
    },
    [],
  )

  const closeChannel = useCallback(
    (channelId: ChannelId, counterpartyNodeId: Uint8Array): boolean => {
      if (!nodeRef.current) throw new Error('Node not initialized')
      const result = nodeRef.current.channelManager.close_channel(
        channelId,
        counterpartyNodeId,
      )
      if (!result.is_ok()) {
        console.error('[ldk] close_channel failed:', result)
        return false
      }
      console.log('[ldk] close_channel initiated')
      return true
    },
    [],
  )

  const forceCloseChannel = useCallback(
    (channelId: ChannelId, counterpartyNodeId: Uint8Array): boolean => {
      if (!nodeRef.current) throw new Error('Node not initialized')
      const result = nodeRef.current.channelManager.force_close_broadcasting_latest_txn(
        channelId,
        counterpartyNodeId,
        'User-initiated force close',
      )
      if (!result.is_ok()) {
        console.error('[ldk] force_close failed:', result)
        return false
      }
      console.log('[ldk] force_close initiated')
      return true
    },
    [],
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
    (description = 'Zinq Wallet'): string => {
      const node = nodeRef.current
      if (!node) throw new Error('Node not initialized')

      const result = UtilMethods.constructor_create_invoice_from_channelmanager(
        node.channelManager,
        Option_u64Z_None.constructor_none(),
        description,
        3600, // 1 hour expiry
        Option_u16Z_None.constructor_none(),
      )

      if (!(result instanceof Result_Bolt11InvoiceSignOrCreationErrorZ_OK)) {
        console.error('[ldk] create_invoice failed:', result)
        throw new Error('Failed to create invoice')
      }

      return result.res.to_str()
    },
    [],
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
            amountMsat as bigint,
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
        Retry.constructor_attempts(3),
      )

      if (!result.is_ok()) {
        throw new Error('Payment routing failed — no route found or duplicate payment')
      }

      const paymentIdHex = bytesToHex(paymentId)
      setPaymentResult(paymentIdHex, { status: 'pending' })

      const invoiceAmountOpt = invoice.amount_milli_satoshis()
      const resolvedMsat = invoiceAmountOpt instanceof Option_u64Z_Some
        ? invoiceAmountOpt.some
        : amountMsat ?? 0n
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
    [refreshPaymentHistory],
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
        payerNote
          ? Option_StrZ.constructor_some(payerNote)
          : Option_StrZ.constructor_none(),
        paymentId,
        Retry.constructor_attempts(3),
        Option_u64Z.constructor_none(), // max routing fee
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
    [refreshPaymentHistory],
  )

  const sendBip353Payment = useCallback(
    (name: HumanReadableName, amountMsat: bigint): Uint8Array => {
      const node = nodeRef.current
      if (!node) throw new Error('Node not initialized')

      const paymentId = crypto.getRandomValues(new Uint8Array(32))

      // BIP 353 requires DNS resolver nodes (bLIP 32). Currently no resolvers configured
      // for Mutinynet — this will fail gracefully with a timeout.
      const result = node.channelManager.pay_for_offer_from_human_readable_name(
        name,
        amountMsat,
        paymentId,
        Retry.constructor_attempts(3),
        Option_u64Z.constructor_none(), // max routing fee
        [], // dns_resolvers — empty until bLIP 32 resolvers are available on signet
      )

      if (!result.is_ok()) {
        throw new Error('Failed to initiate BIP 353 payment')
      }

      const paymentIdHex = bytesToHex(paymentId)
      setPaymentResult(paymentIdHex, { status: 'pending' })

      void persistPayment({
        paymentHash: paymentIdHex,
        direction: 'outbound',
        amountMsat: amountMsat,
        status: 'pending',
        feePaidMsat: null,
        createdAt: Date.now(),
        failureReason: null,
      }).then(() => void refreshPaymentHistory())

      return paymentId
    },
    [refreshPaymentHistory],
  )

  const abandonPayment = useCallback((paymentId: Uint8Array): void => {
    const node = nodeRef.current
    if (!node) throw new Error('Node not initialized')
    node.channelManager.abandon_payment(paymentId)
  }, [])

  const getPaymentResult = useCallback(
    (paymentId: Uint8Array): PaymentResult | null => {
      return paymentResultsRef.current.get(bytesToHex(paymentId)) ?? null
    },
    [],
  )

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

    initializeLdk(ldkSeed)
      .then(async ({ node, watchState, cleanupEventHandler, setBdkWallet, setPaymentCallback, setChannelClosedCallback, setSyncNeededCallback }) => {
        if (cancelled) return

        nodeRef.current = node

        // Expose node on window for dev console debugging
        if (import.meta.env.DEV) {
          ;(window as unknown as Record<string, unknown>).__ldkNode = node
        }

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
            console.warn('[ldk] Failed to remove known peer after channel close:', err)
          })
        })

        cleanupEventHandlerFn = cleanupEventHandler

        const esplora = new EsploraClient(SIGNET_CONFIG.esploraUrl)
        const confirmables = [
          node.channelManager.as_Confirm(),
          node.chainMonitor.as_Confirm(),
        ]

        syncHandle = startSyncLoop({
          confirmables,
          watchState,
          esplora,
          channelManager: node.channelManager,
          chainMonitor: node.chainMonitor,
          networkGraph: node.networkGraph,
          logger: node.logger,
          scorer: node.scorer,
          intervalMs: SIGNET_CONFIG.chainPollIntervalMs,
          rgsUrl: SIGNET_CONFIG.rgsUrl,
          rgsSyncIntervalTicks: SIGNET_CONFIG.rgsSyncIntervalTicks,
          onStatusChange: (syncStatus) => {
            setState((prev) =>
              prev.status === 'ready' ? { ...prev, syncStatus } : prev,
            )
          },
        })

        // Periodic reconnection: check every 3rd tick (~30s) for channel
        // peers that have dropped and reconnect them from known peers.
        let peerTickCount = 0
        let reconnecting = false

        const maybeReconnectPeers = () => {
          if (reconnecting) return
          const channels = node.channelManager.list_channels()
          if (channels.length === 0) return

          // Build set of pubkeys that have channels
          const channelPeerPubkeys = new Set<string>()
          for (const ch of channels) {
            channelPeerPubkeys.add(bytesToHex(ch.get_counterparty().get_node_id()))
          }

          // Build set of currently connected peers
          const connectedPubkeys = new Set<string>()
          for (const peer of node.peerManager.list_peers()) {
            connectedPubkeys.add(bytesToHex(peer.get_counterparty_node_id()))
          }

          // Find channel peers that are disconnected
          const disconnected = [...channelPeerPubkeys].filter((pk) => !connectedPubkeys.has(pk))
          if (disconnected.length === 0) return

          reconnecting = true
          console.log(`[ldk] ${disconnected.length} channel peer(s) disconnected, attempting reconnect`)

          getKnownPeers()
            .then(async (known) => {
              const results = await Promise.allSettled(
                disconnected
                  .filter((pk) => known.has(pk))
                  .map(async (pk) => {
                    const { host, port } = known.get(pk)!
                    activeConnections.current.get(pk)?.disconnect()
                    const conn = await doConnectToPeer(node.peerManager, pk, host, port)
                    activeConnections.current.set(pk, conn)
                  })
              )
              const succeeded = results.filter((r) => r.status === 'fulfilled').length
              const failed = results.filter((r) => r.status === 'rejected').length
              if (succeeded > 0 || failed > 0) {
                console.log(`[ldk] peer reconnect: ${succeeded} reconnected, ${failed} failed`)
              }
            })
            .catch((err: unknown) => {
              console.warn('[ldk] peer reconnect failed:', err)
            })
            .finally(() => {
              reconnecting = false
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

          // Drain LDK events from ChannelManager, ChainMonitor, and OnionMessenger
          node.channelManager
            .as_EventsProvider()
            .process_pending_events(node.eventHandler)
          node.chainMonitor
            .as_EventsProvider()
            .process_pending_events(node.eventHandler)
          node.onionMessenger
            .as_EventsProvider()
            .process_pending_events(node.eventHandler)

          // Recompute Lightning balance and update context if changed
          const capacityMsat = node.channelManager
            .list_usable_channels()
            .reduce((sum, ch) => sum + ch.get_outbound_capacity_msat(), 0n)
          const newBalanceSats = msatToSatFloor(capacityMsat)
          const balanceChanged = newBalanceSats !== lightningBalanceSatsRef.current

          // Detect channel state changes (count, ready, usable status)
          const channels = node.channelManager.list_channels()
          const snapshot = channels
            .map((ch) => `${bytesToHex(ch.get_channel_id().write())}:${ch.get_is_channel_ready()}:${ch.get_is_usable()}`)
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
                ? { ...prev, lightningBalanceSats: newBalanceSats, channelChangeCounter: newCounter }
                : prev,
            )
          }

          // Flush ChannelManager state immediately after processing events
          if (node.channelManager.get_and_clear_needs_persistence()) {
            const data = node.channelManager.write()
            void idbPut('ldk_channel_manager', 'primary', data).catch(
              (err: unknown) => {
                console.error(
                  '[LDK Context] Failed to persist ChannelManager after events:',
                  err,
                )
              },
            )
          }
        }, SIGNET_CONFIG.peerTimerIntervalMs)

        // Compute initial Lightning balance eagerly so Home screen
        // does not show 0 for up to 10s before the first timer tick.
        const initialCapacityMsat = node.channelManager
          .list_usable_channels()
          .reduce((sum, ch) => sum + ch.get_outbound_capacity_msat(), 0n)
        const initialBalanceSats = msatToSatFloor(initialCapacityMsat)
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
          setBdkWallet,
          setSyncNeeded: setSyncNeededCallback,
          createInvoice,
          sendBolt11Payment,
          sendBolt12Payment,
          sendBip353Payment,
          abandonPayment,
          getPaymentResult,
          listRecentPayments,
          outboundCapacityMsat,
          lightningBalanceSats: initialBalanceSats,
          channelChangeCounter: 0,
          peersReconnected: false,
          paymentHistory: initialPaymentHistory,
        })

        // Auto-reconnect to known peers, then mark peersReconnected so
        // the Home screen knows the lightning balance is now accurate.
        getKnownPeers()
          .then(async (peers) => {
            if (peers.size === 0) {
              setState((prev) =>
                prev.status === 'ready' ? { ...prev, peersReconnected: true } : prev,
              )
              return
            }
            console.log(`[ldk] reconnecting to ${peers.size} known peer(s)`)
            const results = await Promise.allSettled(
              Array.from(peers.entries()).map(async ([pubkey, { host, port }]) => {
                const conn = await doConnectToPeer(node.peerManager, pubkey, host, port)
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

            const cap = node.channelManager
              .list_usable_channels()
              .reduce((sum, ch) => sum + ch.get_outbound_capacity_msat(), 0n)
            const bal = msatToSatFloor(cap)
            lightningBalanceSatsRef.current = bal
            setState((prev) =>
              prev.status === 'ready'
                ? { ...prev, lightningBalanceSats: bal, peersReconnected: true }
                : prev,
            )
          })
          .catch((err: unknown) => {
            console.warn('[ldk] failed to read known peers:', err)
            // Still mark as reconnected so UI doesn't stay loading forever
            setState((prev) =>
              prev.status === 'ready' ? { ...prev, peersReconnected: true } : prev,
            )
          })
      })
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
          idbPut('ldk_channel_manager', 'primary', channelManager.write()),
          idbPut('ldk_network_graph', 'primary', networkGraph.write()),
          idbPut('ldk_scorer', 'primary', scorer.write()),
        ]).catch((err: unknown) =>
          console.error('[LDK] Visibility-change persist failed:', err),
        )
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      syncHandle?.stop()
      cleanupEventHandlerFn?.()
      if (peerTimerId !== null) clearInterval(peerTimerId)
      for (const [, conn] of activeConnections.current) {
        conn.disconnect()
      }
      activeConnections.current.clear()
      nodeRef.current = null
    }
  }, [connectToPeer, forgetPeer, createChannel, closeChannel, forceCloseChannel, listChannels, createInvoice, sendBolt11Payment, sendBolt12Payment, sendBip353Payment, abandonPayment, getPaymentResult, listRecentPayments, outboundCapacityMsat, refreshPaymentHistory, ldkSeed])

  return <LdkContext value={state}>{children}</LdkContext>
}
