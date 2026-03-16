import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import {
  UtilMethods,
  Retry,
  Option_u64Z,
  Option_u64Z_Some,
  Option_StrZ,
  Option_ThirtyTwoBytesZ_Some,
  Option_PaymentFailureReasonZ_Some,
  Result_C3Tuple_ThirtyTwoBytesRecipientOnionFieldsRouteParametersZNoneZ_OK,
  type Bolt11Invoice,
  type Offer,
  type HumanReadableName,
} from 'lightningdevkit'
import { initializeLdk, type LdkNode } from './init'
import { LdkContext, defaultLdkContextValue, type LdkContextValue, type PaymentResult } from './ldk-context'
import { SIGNET_CONFIG } from './config'
import { EsploraClient } from './sync/esplora-client'
import { startSyncLoop } from './sync/chain-sync'
import { connectToPeer as doConnectToPeer } from './peers/peer-connection'
import { idbPut } from './storage/idb'
import { getKnownPeers, putKnownPeer, deleteKnownPeer } from './storage/known-peers'
import { bytesToHex } from './utils'

export function LdkProvider({
  children,
  ldkSeed,
}: {
  children: ReactNode
  ldkSeed: Uint8Array
}) {
  const [state, setState] = useState<LdkContextValue>(defaultLdkContextValue)
  const nodeRef = useRef<LdkNode | null>(null)

  const connectToPeer = useCallback(
    async (pubkey: string, host: string, port: number): Promise<void> => {
      if (!nodeRef.current) throw new Error('Node not initialized')
      await doConnectToPeer(nodeRef.current.peerManager, pubkey, host, port)
      putKnownPeer(pubkey, host, port).catch((err: unknown) =>
        console.warn('[ldk] failed to persist known peer:', err)
      )
    },
    []
  )

  const createChannel = useCallback(
    (counterpartyPubkey: Uint8Array, channelValueSats: bigint): boolean => {
      if (!nodeRef.current) throw new Error('Node not initialized')
      const bytes = new Uint8Array(8)
      crypto.getRandomValues(bytes)
      const userChannelId = bytes.reduce(
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

      setPaymentResult(bytesToHex(paymentId), { status: 'pending' })
      return paymentId
    },
    [],
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

      setPaymentResult(bytesToHex(paymentId), { status: 'pending' })
      return paymentId
    },
    [],
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

      setPaymentResult(bytesToHex(paymentId), { status: 'pending' })
      return paymentId
    },
    [],
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
      .then(({ node, watchState, cleanupEventHandler, setBdkWallet, setPaymentCallback }) => {
        if (cancelled) return

        nodeRef.current = node

        // Expose node on window for dev console debugging
        if (import.meta.env.DEV) {
          ;(window as unknown as Record<string, unknown>).__ldkNode = node
        }

        // Wire payment event callback to update the result store
        setPaymentCallback((event) => {
          if (event.type === 'sent') {
            setPaymentResult(event.paymentHash, {
              status: 'sent',
              preimage: event.preimage,
              feePaidMsat: event.feePaidMsat,
            })
          } else {
            setPaymentResult(event.paymentHash, {
              status: 'failed',
              reason: event.reason,
            })
          }
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
        })

        // PeerManager timer + LDK event processing every ~10s
        peerTimerId = setInterval(() => {
          node.peerManager.timer_tick_occurred()
          node.peerManager.process_events()

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

        setState({
          status: 'ready',
          node,
          nodeId: node.nodeId,
          error: null,
          syncStatus: 'syncing',
          connectToPeer,
          forgetPeer,
          createChannel,
          setBdkWallet,
          sendBolt11Payment,
          sendBolt12Payment,
          sendBip353Payment,
          abandonPayment,
          getPaymentResult,
          listRecentPayments,
          outboundCapacityMsat,
        })

        // Auto-reconnect to known peers (fire-and-forget, non-blocking)
        getKnownPeers()
          .then(async (peers) => {
            if (peers.size === 0) return
            console.log(`[ldk] reconnecting to ${peers.size} known peer(s)`)
            const results = await Promise.allSettled(
              Array.from(peers.entries()).map(([pubkey, { host, port }]) =>
                doConnectToPeer(node.peerManager, pubkey, host, port)
              )
            )
            const succeeded = results.filter((r) => r.status === 'fulfilled').length
            const failed = results.filter((r) => r.status === 'rejected').length
            console.log(`[ldk] peer reconnection: ${succeeded} connected, ${failed} failed`)
          })
          .catch((err: unknown) => {
            console.warn('[ldk] failed to read known peers:', err)
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

    return () => {
      cancelled = true
      syncHandle?.stop()
      cleanupEventHandlerFn?.()
      if (peerTimerId !== null) clearInterval(peerTimerId)
      nodeRef.current = null
    }
  }, [connectToPeer, forgetPeer, createChannel, sendBolt11Payment, sendBolt12Payment, sendBip353Payment, abandonPayment, getPaymentResult, listRecentPayments, outboundCapacityMsat, ldkSeed])

  return <LdkContext value={state}>{children}</LdkContext>
}
