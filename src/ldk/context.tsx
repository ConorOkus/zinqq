import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import {
  Retry,
  Option_u64Z,
  Option_u64Z_Some,
  Option_u64Z_None,
  Option_u16Z_None,
  Option_u32Z,
  Option_StrZ,
  Option_ThirtyTwoBytesZ,
  Description,
  Bolt11InvoiceDescription,
  RouteParametersConfig,
  Result_C2Tuple_ThirtyTwoBytesThirtyTwoBytesZNoneZ_OK,
  Result_DescriptionCreationErrorZ_OK,
  Result_Bolt11InvoiceSignOrCreationErrorZ_OK,
  Result_OfferWithDerivedMetadataBuilderBolt12SemanticErrorZ_OK,
  Result_OfferBolt12SemanticErrorZ_OK,
  type ChannelId,
  type Bolt11Invoice,
  type Offer,
} from 'lightningdevkit'
import { initializeLdk, WALLET_LOCK_CHANNEL, type LdkNode } from './init'
import { VssClient, SignatureHeaderProvider } from './storage/vss-client'
import {
  LdkContext,
  defaultLdkContextValue,
  type LdkContextValue,
  type PaymentResult,
} from './ldk-context'
import { LDK_CONFIG } from './config'
import { resolveLspContacts, type LspContact } from './lsp/contacts'
import { fetchLqwdContact } from './lsp/lqwd-discovery'
import { EsploraClient } from './sync/esplora-client'
import { startSyncLoop } from './sync/chain-sync'
import { connectToPeer as doConnectToPeer, type PeerConnection } from './peers/peer-connection'
import { reconnectDisconnectedPeers } from './peers/peer-reconnect'
import { idbPut } from '../storage/idb'
import {
  persistChannelManagerIdbOnly,
  type ChannelManagerPersistScheduler,
} from './storage/persist-cm'
import { getKnownPeers, putKnownPeer, deleteKnownPeer } from './storage/known-peers'
import { getPersistedOffer, putPersistedOffer } from './storage/offer'
import { persistPayment, loadAllPayments } from './storage/payment-history'
import { bytesToHex, hexToBytes } from './utils'
import { msatToSatFloor } from '../utils/msat'
import { captureError } from '../storage/error-log'
import {
  selectCheapestParams,
  calculateOpeningFee,
  computeMinReceiveSats,
  MIN_JIT_RECEIVE_SATS,
  type JitInvoiceResult,
  type LSPS2OpeningFeeParams,
} from './lsps2/types'
import { enterRecovery, notifyRecoveryStateChanged } from './recovery/use-recovery'
import {
  readRecoveryState,
  writeRecoveryState,
  clearRecoveryState,
  seedRecoveryVssVersion,
} from './recovery/recovery-state'
import { sweepSpendableOutputs } from './sweep'
import { revealNextAddress } from '../onchain/address-utils'
import { ONCHAIN_CONFIG } from '../onchain/config'

function getOutboundCapacitySats(cm: import('lightningdevkit').ChannelManager): bigint {
  const msat = cm
    .list_usable_channels()
    .reduce((sum, ch) => sum + ch.get_outbound_capacity_msat(), 0n)
  return msatToSatFloor(msat)
}

/** Connect failed and the peer is still not present in PeerManager.list_peers. */
export class JitPeerConnectError extends Error {
  readonly trigger = 'peer_connect' as const
}

/**
 * No fee_params menu entry accepts the requested amount (size or fee bound).
 * Carries the menu and contact so the Receive page can render a
 * "Minimum receive: ₿X" affordance instead of silently degrading.
 */
export class JitPaymentSizeOutOfRangeError extends Error {
  readonly trigger = 'payment_size_filter' as const
  readonly menu: LSPS2OpeningFeeParams[]
  readonly contact: LspContact
  constructor(message: string, menu: LSPS2OpeningFeeParams[], contact: LspContact) {
    super(message)
    this.menu = menu
    this.contact = contact
  }
}

/** LSP returned a quote whose `valid_until` leaves too little headroom to commit. */
export class JitQuoteFreshnessError extends Error {
  readonly trigger = 'quote_freshness' as const
}

type JitTrigger =
  | 'http_preflight'
  | 'peer_connect'
  | 'payment_size_filter'
  | 'quote_freshness'
  | 'aborted'
  | 'lsps2_rpc'

function classifyJitTrigger(err: unknown): JitTrigger {
  if (err instanceof JitPeerConnectError) return 'peer_connect'
  if (err instanceof JitPaymentSizeOutOfRangeError) return 'payment_size_filter'
  if (err instanceof JitQuoteFreshnessError) return 'quote_freshness'
  if (err instanceof DOMException && err.name === 'AbortError') return 'aborted'
  return 'lsps2_rpc'
}

type ConnectFn = (
  peerManager: import('lightningdevkit').PeerManager,
  pubkey: string,
  host: string,
  port: number
) => Promise<void>

/**
 * A read-only LSPS2 quote: enough to display fee disclosure and later commit
 * via `executeJitBuy` against the same LSP. The quote is pinned to a specific
 * `amountMsat`; any change in the displayed amount requires a new quote.
 */
export interface JitQuote {
  contact: LspContact
  /** The exact `LSPS2OpeningFeeParams` displayed to the user (signed by the LSP via `promise`). */
  params: LSPS2OpeningFeeParams
  /** The full menu — `selectCheapestParams` already picked `params`, but the menu drives `computeMinReceiveSats` for the below-minimum UI. */
  menu: LSPS2OpeningFeeParams[]
  /** Pre-computed opening fee for `amountMsat` against `params`. */
  openingFeeMsat: bigint
  /** The amount the quote covers, in msat. */
  amountMsat: bigint
  /**
   * Which LSP slot served this quote. Stamped by `runJitQuoteFlow` (the only
   * entry point the receive UI uses) — a raw `getJitQuote` result leaves it
   * undefined. Drives the buy-phase fallback decision and the fallback fee
   * disclosure; never compare LSP labels for that.
   */
  role?: 'primary' | 'fallback'
}

type GetJitQuoteFn = (
  node: LdkNode,
  contact: LspContact,
  amountMsat: bigint,
  connect: ConnectFn,
  opts: { retryConnectOnce: boolean },
  signal: AbortSignal
) => Promise<JitQuote>

/** Phase A overall budget across all LSP attempts. */
const PHASE_A_TOTAL_BUDGET_MS = 14_000
/** Per-LSP budget within Phase A (connect + RPC). */
const PHASE_A_PER_LSP_BUDGET_MS = 7_000

/**
 * Build a DOM-style abort/timeout error as an `Error` subtype so it satisfies
 * `@typescript-eslint/prefer-promise-reject-errors`. Names match the
 * convention used by `AbortController.abort()` and `fetch` so callers can
 * still discriminate via `err.name === 'AbortError' | 'TimeoutError'`.
 */
function abortError(message = 'Aborted'): Error {
  const err = new Error(message)
  err.name = 'AbortError'
  return err
}

function timeoutError(): Error {
  const err = new Error('Timeout')
  err.name = 'AbortError' // treated like abort by callers; cheaper than a separate class
  return err
}

/**
 * Race a promise against an `AbortSignal`. If the signal aborts, the returned
 * promise rejects with `AbortError`. The underlying promise is not actually
 * cancelled (we don't have signal plumbed into RPC primitives yet); this
 * only short-circuits the await for the caller.
 */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError())
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

/**
 * Derive a child `AbortSignal` that fires after `ms` or when `parent` aborts,
 * whichever happens first.
 */
function timeoutSignal(parent: AbortSignal, ms: number): AbortSignal {
  const ctrl = new AbortController()
  if (parent.aborted) {
    ctrl.abort(parent.reason as Error | undefined)
    return ctrl.signal
  }
  const timer = setTimeout(() => ctrl.abort(timeoutError()), ms)
  parent.addEventListener(
    'abort',
    () => {
      clearTimeout(timer)
      ctrl.abort(parent.reason as Error | undefined)
    },
    { once: true }
  )
  return ctrl.signal
}

/**
 * Phase A — fetch a JIT quote against ONE LSP. Throws typed errors so
 * `runJitQuoteFlow` can classify the failure for failover and telemetry.
 *
 * No LSP-side commitment is made; this is a pure read. The reservation
 * happens later in `executeJitBuy` (Phase B).
 */
export async function getJitQuote(
  node: LdkNode,
  contact: LspContact,
  amountMsat: bigint,
  connect: ConnectFn,
  opts: { retryConnectOnce: boolean },
  signal: AbortSignal
): Promise<JitQuote> {
  // Step 0: Ensure peer connection. Skip the connect() call when LDK
  // already has the peer — `new_outbound_connection` rejects a duplicate
  // and we'd uselessly fail through to fallback. This is the common case
  // for the LSP we just ran a quote against, or one we auto-reconnected
  // to on startup because of an existing channel.
  const alreadyConnected = (): boolean =>
    node.peerManager
      .list_peers()
      .some((p) => bytesToHex(p.get_counterparty_node_id()) === contact.nodeId)

  if (!alreadyConnected()) {
    try {
      await withAbort(connect(node.peerManager, contact.nodeId, contact.host, contact.port), signal)
    } catch (firstErr) {
      if (signal.aborted) throw firstErr
      // A parallel attempt may have raced us to a connected state.
      if (alreadyConnected()) {
        // fall through — connection is up, proceed to LSPS2 RPC
      } else if (!opts.retryConnectOnce) {
        throw new JitPeerConnectError(`peer_connect (${contact.label}): ${String(firstErr)}`)
      } else {
        // Soft retry — mobile WebSockets die when backgrounded.
        try {
          await withAbort(
            connect(node.peerManager, contact.nodeId, contact.host, contact.port),
            signal
          )
        } catch (secondErr) {
          if (signal.aborted) throw secondErr
          throw new JitPeerConnectError(
            `peer_connect (${contact.label}, retry): ${String(secondErr)}`
          )
        }
      }
    }
  }

  // Step 1: Get opening fee params from LSP.
  const feeMenu = await withAbort(
    node.lsps2Client.getOpeningFeeParams(contact.nodeId, contact.token),
    signal
  )

  // Drift guard (todo 372): the static numpad floor (MIN_JIT_RECEIVE_SATS) must
  // dominate every LSP's live menu minimum, otherwise the gate admits amounts a
  // fallback LSP can't service. We can't pre-fetch menus (no-prewarm rule), so
  // verify it here on a real quote and surface drift as an observable signal.
  const menuMinSats = computeMinReceiveSats(feeMenu)
  if (menuMinSats > MIN_JIT_RECEIVE_SATS) {
    captureError(
      'warning',
      'LSP',
      `LSP menu minimum exceeds MIN_JIT_RECEIVE_SATS — numpad floor may admit unservable amounts`,
      JSON.stringify({
        lsp: contact.label,
        menuMinSats: menuMinSats.toString(),
        floorSats: MIN_JIT_RECEIVE_SATS.toString(),
      })
    )
  }

  // Step 2: Select cheapest valid params for this amount. Null means the
  // LSP's fee menu has no entry whose payment-size range covers
  // `amountMsat` (or whose fee is less than the payment) — failover-eligible.
  const params = selectCheapestParams(feeMenu, amountMsat)
  if (!params) {
    throw new JitPaymentSizeOutOfRangeError(
      `no fee params accept ${amountMsat.toString()} msat from ${contact.label}`,
      feeMenu,
      contact
    )
  }

  // Internal sanity gate: reject quotes with <30s remaining. The Receive
  // page applies a separate, looser 60s on-tap freshness check before
  // committing (Phase 4) so that a fresh-enough-to-display quote isn't
  // re-fetched on every Generate tap.
  if (new Date(params.validUntil).getTime() < Date.now() + 30_000) {
    throw new JitQuoteFreshnessError('Fee parameters expiring too soon, please try again')
  }

  const openingFeeMsat = calculateOpeningFee(amountMsat, params)
  return { contact, params, menu: feeMenu, openingFeeMsat, amountMsat }
}

/**
 * Phase B — commit a previously-displayed quote and produce a BOLT11 invoice.
 * Single-LSP, NOT failover-eligible: `buyChannel` reserves LSP-side liquidity,
 * and rolling to a different LSP after that would orphan the commitment.
 *
 * The `signal` is only checked at entry; once `buyChannel` has been issued,
 * we run to completion regardless of abort to avoid leaving the LSP holding
 * a reservation we won't redeem.
 */
export async function executeJitBuy(
  node: LdkNode,
  quote: JitQuote,
  description: string,
  signal: AbortSignal
): Promise<JitInvoiceResult> {
  if (signal.aborted) {
    throw abortError()
  }

  // Surface the open `accept_underpaying_htlcs` gap in the incident log so
  // any "I asked for X, got Y" report can be correlated to the buy event.
  // The wallet sets `accept_underpaying_htlcs=true` (`init.ts:151`); LDK
  // therefore won't reject HTLCs that pay LESS than the displayed fee.
  // Claim-time enforcement (rejecting `actual < invoiceAmountMsat -
  // openingFeeMsat`) is tracked in todo 306 and slated for PR 2.
  captureError(
    'warning',
    'LSP',
    'JIT buy committed; HTLC underpayment beyond disclosed fee is not bound-checked at claim time (todo 306)',
    JSON.stringify({
      amount_msat: quote.amountMsat.toString(),
      opening_fee_msat: quote.openingFeeMsat.toString(),
      lsp: quote.contact.label,
    })
  )

  // Step 3: Buy JIT channel. Past this line, abort is ignored — orphaning
  // an LSP commitment is worse than running to completion.
  const buyResponse = await node.lsps2Client.buyChannel(
    quote.contact.nodeId,
    quote.params,
    quote.amountMsat
  )

  // Step 4: Register the inbound payment with LDK. We pass `amountMsat -
  // openingFeeMsat` as the expected amount so the LSP's fee deduction at
  // forward time produces a valid HTLC. NOTE: `accept_underpaying_htlcs=true`
  // (set wallet-wide in `init.ts:151`) means LDK does NOT enforce a lower
  // bound on `claimable_amount_msat` against `expectedReceiveMsat` — the
  // claim-time bound check is deferred to PR 2 (see todo 306).
  const expectedReceiveMsat = quote.amountMsat - quote.openingFeeMsat
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

  // Step 5: Build and sign the BOLT11 invoice with JIT route hint.
  const nodeIdBytes = hexToBytes(node.nodeId)
  const bolt11 = await node.lsps2Client.createJitInvoice({
    buyResponse,
    lspNodeId: quote.contact.nodeId,
    amountMsat: quote.amountMsat,
    description,
    nodeId: nodeIdBytes,
    nodeSecretKey: node.nodeSecretKey,
    paymentHash,
    paymentSecret,
    minFinalCltvExpiry: 144,
  })

  return {
    bolt11,
    openingFeeMsat: quote.openingFeeMsat,
    paymentHash: bytesToHex(paymentHash),
  }
}

/**
 * Orchestrate a JIT-quote request with primary/fallback semantics.
 * Pure (no React/refs) — `requestJitInvoice` is a thin wrapper that
 * supplies `node`, `connect`, and pre-resolved contacts.
 *
 * Failover triggers (any of these on the primary):
 *   - http_preflight: discovery failed (primary contact = null)
 *   - peer_connect: WebSocket / BOLT 8 connect failed
 *   - lsps2_rpc: LSPS2 JSON-RPC failed or timed out
 *   - payment_size_filter: no fee_params menu entry covers the amount
 *   - quote_freshness: LSP returned a quote with too little headroom
 *   - aborted (per-LSP timeout only): the per-LSP budget elapsed
 *
 * Phase A budget: 14s overall, 7s per LSP. The overall budget short-circuits
 * fallback if the primary attempt itself exhausted the wall clock.
 *
 * On both-fail (or overall-budget-exceeded), throws (caller —
 * `Receive.tsx` — degrades to on-chain).
 */
export async function runJitQuoteFlow(args: {
  node: LdkNode
  amountMsat: bigint
  connect: ConnectFn
  contacts: { primary: LspContact | null; fallback: LspContact | null }
  /** External cancellation (e.g. user tapped Back). */
  signal?: AbortSignal
  /** Test seam: defaults to the real LSPS2 quote dance. */
  attempt?: GetJitQuoteFn
  /**
   * Skip the primary LSP and quote the fallback directly. Used by the
   * buy-phase fallback: when a buy fails against the primary, the primary
   * is unhealthy, so we re-quote the fallback rather than loop on it.
   */
  skipPrimary?: boolean
}): Promise<JitQuote> {
  const attempt = args.attempt ?? getJitQuote
  const { node, amountMsat, connect } = args
  const contacts = args.skipPrimary
    ? { primary: null, fallback: args.contacts.fallback }
    : args.contacts
  const t0 = performance.now()

  if (!contacts.primary && !contacts.fallback) {
    throw new Error('LSP not configured')
  }

  const externalSignal = args.signal ?? new AbortController().signal
  const overallSignal = timeoutSignal(externalSignal, PHASE_A_TOTAL_BUDGET_MS)

  if (contacts.primary) {
    try {
      const perLspSignal = timeoutSignal(overallSignal, PHASE_A_PER_LSP_BUDGET_MS)
      const quote = await attempt(
        node,
        contacts.primary,
        amountMsat,
        connect,
        { retryConnectOnce: false },
        perLspSignal
      )
      return { ...quote, role: 'primary' }
    } catch (err) {
      // Don't try fallback if the user externally cancelled.
      if (externalSignal.aborted) throw err
      // Don't try fallback if the OVERALL budget is gone (vs. only the per-LSP).
      if (overallSignal.aborted) {
        captureError(
          'error',
          'LSP',
          `phase A budget exhausted on primary, skipping fallback`,
          JSON.stringify({
            primary: contacts.primary.label,
            trigger: classifyJitTrigger(err),
            duration_ms: Math.round(performance.now() - t0),
          })
        )
        throw err
      }
      if (!contacts.fallback) {
        captureError(
          'error',
          'LSP',
          `primary lsp failed and no fallback configured`,
          JSON.stringify({
            primary: contacts.primary.label,
            trigger: classifyJitTrigger(err),
            error: String(err),
          })
        )
        throw err
      }
      captureError(
        'warning',
        'LSP',
        `falling back from ${contacts.primary.label} to ${contacts.fallback.label}`,
        JSON.stringify({
          trigger: classifyJitTrigger(err),
          primary: contacts.primary.label,
          fallback: contacts.fallback.label,
          duration_ms: Math.round(performance.now() - t0),
        })
      )
    }
  } else {
    // Primary discovery failed (HTTP /get_info preflight error). Skip
    // straight to fallback; resolveLspContacts already swallowed the error.
    captureError(
      'warning',
      'LSP',
      `primary discovery failed, falling back to ${contacts.fallback!.label}`,
      JSON.stringify({
        trigger: 'http_preflight',
        fallback: contacts.fallback!.label,
      })
    )
  }

  // Fallback attempt. Preserve the historical soft retry on connect —
  // mobile WebSockets die when backgrounded.
  const perLspSignal = timeoutSignal(overallSignal, PHASE_A_PER_LSP_BUDGET_MS)
  try {
    const quote = await attempt(
      node,
      contacts.fallback!,
      amountMsat,
      connect,
      { retryConnectOnce: true },
      perLspSignal
    )
    return { ...quote, role: 'fallback' }
  } catch (err) {
    captureError(
      'error',
      'LSP',
      `both lsps failed, degrading to on-chain`,
      JSON.stringify({
        fallback_trigger: classifyJitTrigger(err),
        duration_ms: Math.round(performance.now() - t0),
        error: String(err),
      })
    )
    throw err
  }
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

  /** Connect to a peer and track the connection. Disconnects any stale entry first. */
  const connectAndTrack = async (
    peerManager: import('lightningdevkit').PeerManager,
    pubkey: string,
    host: string,
    port: number
  ): Promise<void> => {
    const conn = await doConnectToPeer(peerManager, pubkey, host, port, () =>
      drainEventsRef.current?.()
    )
    activeConnections.current.get(pubkey)?.disconnect()
    activeConnections.current.set(pubkey, conn)
  }

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
      await connectAndTrack(nodeRef.current.peerManager, pubkey, host, port)
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

  const disconnectPeer = useCallback((pubkey: string): void => {
    const conn = activeConnections.current.get(pubkey)
    if (conn) {
      conn.disconnect()
      activeConnections.current.delete(pubkey)
    }
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

      // LDK 0.2: create_bolt11_invoice is a ChannelManager method (the old
      // UtilMethods.constructor_create_invoice_from_channelmanager was removed)
      // and takes a Bolt11InvoiceDescription rather than a raw string.
      const descResult = Description.constructor_new(description)
      if (!(descResult instanceof Result_DescriptionCreationErrorZ_OK)) {
        throw new Error('Invalid invoice description')
      }
      const result = node.channelManager.create_bolt11_invoice(
        amountOption,
        Bolt11InvoiceDescription.constructor_direct(descResult.res),
        Option_u32Z.constructor_some(3600), // 1 hour expiry
        Option_u16Z_None.constructor_none(),
        Option_ThirtyTwoBytesZ.constructor_none()
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

  const requestJitQuote = useCallback(
    async (
      amountMsat: bigint,
      signal: AbortSignal,
      opts?: { skipPrimary?: boolean }
    ): Promise<JitQuote> => {
      const node = nodeRef.current
      if (!node) throw new Error('Node not initialized')
      const contacts = await resolveLspContacts()
      return runJitQuoteFlow({
        node,
        amountMsat,
        connect: connectAndTrack,
        contacts,
        signal,
        skipPrimary: opts?.skipPrimary,
      })
    },
    []
  )

  const executeJitBuyCallback = useCallback(
    async (
      quote: JitQuote,
      description: string,
      signal: AbortSignal
    ): Promise<JitInvoiceResult> => {
      const node = nodeRef.current
      if (!node) throw new Error('Node not initialized')
      return executeJitBuy(node, quote, description, signal)
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

      // Use the payment hash as the payment ID (guaranteed unique per invoice).
      const paymentHash = invoice.payment_hash()
      const paymentId = paymentHash

      // LDK 0.2: pay_for_bolt11_invoice replaces the manual
      // payment_parameters_from_invoice + send_payment sequence. amount_msats is
      // an override used only for zero-amount invoices.
      const result = node.channelManager.pay_for_bolt11_invoice(
        invoice,
        paymentId,
        hasAmount
          ? Option_u64Z.constructor_none()
          : Option_u64Z.constructor_some(amountMsat as bigint),
        RouteParametersConfig.constructor_default(),
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
    async (offer: Offer, amountMsat?: bigint, payerNote?: string): Promise<Uint8Array> => {
      const node = nodeRef.current
      if (!node) throw new Error('Node not initialized')

      // Ensure LSP is connected so onion messages can route.
      // On mobile browsers, WebSockets die when backgrounded.
      const lspNodeId = LDK_CONFIG.lspNodeId
      const lspHost = LDK_CONFIG.lspHost
      if (lspNodeId && lspHost) {
        const isConnected = node.peerManager
          .list_peers()
          .some((p) => bytesToHex(p.get_counterparty_node_id()) === lspNodeId)

        if (!isConnected) {
          await connectAndTrack(node.peerManager, lspNodeId, lspHost, LDK_CONFIG.lspPort)
        }
      }

      // Use 8 random bytes for payment ID (safe u128 range per institutional learning)
      const paymentId = crypto.getRandomValues(new Uint8Array(32))

      // LDK 0.2: pay_for_offer dropped the `quantity` arg and folded max-routing-fee
      // into RouteParametersConfig; remaining optional params are payer_note,
      // route_params_config, retry_strategy.
      const result = node.channelManager.pay_for_offer(
        offer,
        amountMsat != null
          ? Option_u64Z.constructor_some(amountMsat)
          : Option_u64Z.constructor_none(),
        paymentId,
        payerNote ? Option_StrZ.constructor_some(payerNote) : Option_StrZ.constructor_none(),
        RouteParametersConfig.constructor_default(),
        Retry.constructor_attempts(3)
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
    let cmPersistScheduler: ChannelManagerPersistScheduler | null = null

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
          setRecoveryNeededCallback,
          cmPersistScheduler: persistScheduler,
        }) => {
          if (cancelled) return

          nodeRef.current = node
          // Scheduler is constructed once in init.ts; here we just hold the
          // reference for teardown. Lifetime mirrors the node — no cache
          // needed (see todos #341, #350).
          cmPersistScheduler = persistScheduler
          const schedulePersist = persistScheduler.schedule

          // Eagerly discover LQwD's pubkey and add it to the trust set so
          // the event handler accepts 0-conf opens from the primary LSP.
          // Fire-and-forget: if discovery fails, we silently continue with
          // only Megalith trusted (the receive flow will then fall back).
          // See todos/291 (P1 from PR #148 review).
          void fetchLqwdContact()
            .then((contact) => {
              if (cancelled) return
              node.trustedLspIds.add(contact.nodeId)
            })
            .catch(() => {
              // Discovery failure is logged elsewhere; don't double-log.
            })

          // Expose node on window for dev console debugging (exclude secret key)
          if (import.meta.env.DEV) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { nodeSecretKey: _secret, ...safeNode } = node
            ;(window as unknown as Record<string, unknown>).__ldkNode = safeNode
          }

          // Expose recovery functions for agent/programmatic access.
          // Available in all environments so agents can check recovery status,
          // read the deposit address, and dismiss the success banner.
          ;(window as unknown as Record<string, unknown>).__recovery = {
            getState: readRecoveryState,
            dismiss: () => clearRecoveryState(vssClient),
          }

          // Expose the receive flow for agent/programmatic access. Mirrors
          // the human flow: `quote(sats)` is failover-safe and idempotent
          // (Phase A); `commit(quote)` reserves LSP-side liquidity and
          // MUST NOT be retried blindly (Phase B). `createInvoice` is the
          // standard non-JIT path. Available in all environments.
          ;(window as unknown as Record<string, unknown>).__receive = {
            quote: (amountSats: bigint, signal?: AbortSignal) =>
              requestJitQuote(amountSats * 1000n, signal ?? new AbortController().signal),
            commit: (quote: JitQuote, description = 'zinqq wallet', signal?: AbortSignal) =>
              executeJitBuyCallback(quote, description, signal ?? new AbortController().signal),
            createInvoice,
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
            void connectAndTrack(node.peerManager, nodeIdHex, host, port).catch((err: unknown) => {
              captureError(
                'warning',
                'LDK',
                `ConnectionNeeded reconnect failed: ${nodeIdHex.substring(0, 16)}…`,
                String(err)
              )
            })
          })

          // Wire recovery callback: when CPFP fails, enter recovery state
          setRecoveryNeededCallback((info) => {
            const address = bdkWallet.next_unused_address('external')
            const addressStr = address.address.toString()
            void enterRecovery(info, addressStr, vssClient).catch((err: unknown) => {
              captureError('error', 'LDK', 'Failed to enter recovery state', String(err))
            })
          })

          // Seed VSS version for recovery state on startup
          void seedRecoveryVssVersion(vssClient).catch(() => {})

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
            schedulePersist,
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

            // LDK 0.2 removed Event::PendingHTLCsForwardable; drive forwarding by polling.
            // Run this AFTER draining events so HTLCs made forwardable by this pass are
            // processed in the same cycle. Living here (rather than only in the peer timer)
            // means every drain path — timer, WebSocket message, and tab-foreground — covers
            // HTLC forwarding, so receive/JIT settlement isn't delayed up to a full timer tick.
            if (node.channelManager.needs_pending_htlc_processing()) {
              node.channelManager.process_pending_htlc_forwards()
            }

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

            // Scheduler owns the dirty bit; calling unconditionally is a
            // no-op when nothing changed. On failure the scheduler latches
            // mustRetry so the next chain-sync tick retries.
            void schedulePersist().catch((err: unknown) => {
              captureError(
                'critical',
                'LDK Context',
                'Failed to persist ChannelManager after events',
                String(err)
              )
            })
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

          // Auto-recovery: periodically check if we can sweep stuck outputs.
          // Runs every ~60s (6 ticks) to avoid excessive IDB reads.
          let recoveryTickCount = 0
          let recoveryInProgress = false
          const maybeAutoRecover = () => {
            if (recoveryInProgress) return
            recoveryInProgress = true
            void (async () => {
              try {
                const state = await readRecoveryState()
                if (!state || state.status === 'sweep_confirmed') return

                // Attempt sweep with current UTXOs
                const destScript = revealNextAddress(bdkWallet, 'Recovery')
                const result = await sweepSpendableOutputs(
                  node.keysManager,
                  destScript,
                  ONCHAIN_CONFIG.esploraUrl,
                  LDK_CONFIG.esploraFallbackUrl
                )

                if (result.swept > 0) {
                  // Sweep succeeded — transition to sweep_confirmed
                  const updated = {
                    ...state,
                    status: 'sweep_confirmed' as const,
                    updatedAt: Date.now(),
                  }
                  await writeRecoveryState(updated, vssClient)
                  notifyRecoveryStateChanged()
                  console.log('[Recovery] Auto-sweep succeeded, txid:', result.txid)
                }
              } catch (err: unknown) {
                captureError('warning', 'Recovery', 'Auto-recovery check failed', String(err))
              } finally {
                recoveryInProgress = false
              }
            })()
          }

          // PeerManager timer + LDK event processing every ~10s
          peerTimerId = setInterval(() => {
            node.peerManager.timer_tick_occurred()
            node.peerManager.process_events()
            // HTLC forwarding is handled inside drainEventsAndRefresh() (called below),
            // which every drain path shares.

            // Check for disconnected channel peers every ~30s
            peerTickCount += 1
            if (peerTickCount % 3 === 0) {
              maybeReconnectPeers()
            }

            // Attempt auto-recovery every ~60s
            recoveryTickCount += 1
            if (recoveryTickCount % 6 === 0) {
              maybeAutoRecover()
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
            disconnectPeer,
            createChannel,
            closeChannel,
            forceCloseChannel,
            listChannels,
            bdkWallet,
            bdkEsploraClient,
            setSyncNeeded: setSyncNeededCallback,
            createInvoice,
            requestJitQuote,
            executeJitBuy: executeJitBuyCallback,
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
            vssClient: vssClient ?? null,
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

              const builderResult = node.channelManager.create_offer_builder()
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

          // Auto-reconnect to known peers, then mark peersReconnected so
          // the Home screen knows the lightning balance is now accurate.
          // The LSP is connected here too (either as a known peer if it has
          // channels, or via auto-connect if it doesn't). Connecting in a
          // single path avoids racing two WebSockets to the same peer, which
          // causes LDK to tear down the duplicate and disconnect.
          getKnownPeers()
            .then(async (peers) => {
              // Auto-connect to LSP only if it's NOT already a known peer —
              // known peers are reconnected in the loop below, which also
              // polls for channel usability.
              if (LDK_CONFIG.lspNodeId && LDK_CONFIG.lspHost && !peers.has(LDK_CONFIG.lspNodeId)) {
                void connectAndTrack(
                  node.peerManager,
                  LDK_CONFIG.lspNodeId,
                  LDK_CONFIG.lspHost,
                  LDK_CONFIG.lspPort
                )
                  .then(() => {
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

              if (peers.size === 0) {
                setState((prev) =>
                  prev.status === 'ready' ? { ...prev, peersReconnected: true } : prev
                )
                void loadOrCreateOffer()
                return
              }
              console.log(`[ldk] reconnecting to ${peers.size} known peer(s)`)
              const results = await Promise.allSettled(
                Array.from(peers.entries()).map(([pubkey, { host, port }]) =>
                  connectAndTrack(node.peerManager, pubkey, host, port)
                )
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
      // Suppress trailing scheduler iterations so this tab can't write to
      // VSS after wallet-takeover hands the lock to another tab.
      cmPersistScheduler?.cancel()
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

    // Listen for another tab stealing the wallet lock. When received,
    // tear down this tab's LDK node to prevent dual ChannelManagers.
    const lockChannel = new BroadcastChannel(WALLET_LOCK_CHANNEL)
    lockChannel.onmessage = (event: MessageEvent<{ type: string }>) => {
      if (event.data?.type === 'wallet-takeover') {
        console.warn('[LDK Context] Wallet taken over by another tab — shutting down')
        teardown()
        setState({
          status: 'error',
          node: null,
          nodeId: null,
          error: new Error('Wallet is now open in another tab'),
        })
      }
    }

    return () => {
      lockChannel.close()
      teardown()
    }
  }, [
    connectToPeer,
    forgetPeer,
    disconnectPeer,
    createChannel,
    closeChannel,
    forceCloseChannel,
    listChannels,
    createInvoice,
    requestJitQuote,
    executeJitBuyCallback,
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
