import {
  initializeWasmWebFetch,
  KeysManager,
  Recipient,
  Result_PublicKeyNoneZ_OK,
  ChainMonitor,
  Option_FilterZ,
  ChannelManager,
  UserConfig,
  ChainParameters,
  BestBlock,
  NetworkGraph,
  ProbabilisticScorer,
  ProbabilisticScoringDecayParameters,
  ProbabilisticScoringFeeParameters,
  MultiThreadedLockableScore,
  DefaultRouter,
  DefaultMessageRouter,
  OnionMessenger,
  UtilMethods,
  Result_C2Tuple_ThirtyTwoBytesChannelMonitorZDecodeErrorZ_OK,
  Result_C2Tuple_ThirtyTwoBytesChannelManagerZDecodeErrorZ_OK,
  Result_NetworkGraphDecodeErrorZ_OK,
  Result_ProbabilisticScorerDecodeErrorZ_OK,
  P2PGossipSync,
  Option_UtxoLookupZ,
  PeerManager,
  IgnoringMessageHandler,
  type Logger,
  type FeeEstimator,
  type BroadcasterInterface,
  type Persist,
  type ChannelMonitor,
  type EventHandler,
} from 'lightningdevkit'
import { getSeed, storeDerivedSeed } from './storage/seed'
import { createLogger } from './traits/logger'
import { createFeeEstimator } from './traits/fee-estimator'
import { createBroadcaster } from './traits/broadcaster'
import { createPersister } from './traits/persist'
import { createFilter, type WatchState } from './traits/filter'
import { createEventHandler, type PaymentEventCallback } from './traits/event-handler'
import { SIGNET_CONFIG } from './config'
import { idbGet, idbGetAll } from './storage/idb'
import { bytesToHex, hexToBytes } from './utils'
import { EsploraClient } from './sync/esplora-client'

export interface LdkNode {
  nodeId: string
  keysManager: KeysManager
  logger: Logger
  feeEstimator: FeeEstimator
  broadcaster: BroadcasterInterface
  persister: Persist
  chainMonitor: ChainMonitor
  channelManager: ChannelManager
  networkGraph: NetworkGraph
  scorer: ProbabilisticScorer
  peerManager: PeerManager
  onionMessenger: OnionMessenger
  eventHandler: EventHandler
}

export interface InitResult {
  node: LdkNode
  watchState: WatchState
  cleanupEventHandler: () => void
  setBdkWallet: (wallet: import('@bitcoindevkit/bdk-wallet-web').Wallet | null) => void
  setPaymentCallback: (cb: PaymentEventCallback | undefined) => void
}

// WASM double-init guard: deduplicate concurrent calls from React StrictMode
let wasmInitPromise: Promise<void> | null = null

function initWasm(): Promise<void> {
  if (!wasmInitPromise) {
    wasmInitPromise = initializeWasmWebFetch('/liblightningjs.wasm').catch((err) => {
      wasmInitPromise = null
      throw err
    })
  }
  return wasmInitPromise
}

// Multi-tab lock: prevent two tabs from running independent ChannelManagers
async function acquireWalletLock(): Promise<void> {
  if (!navigator.locks) {
    throw new Error(
      '[LDK Init] Web Locks API not available. ' +
        'A modern browser with Web Locks support is required to prevent multi-tab fund loss.',
    )
  }

  return new Promise<void>((resolve, reject) => {
    void navigator.locks.request('browser-wallet-lock', { ifAvailable: true }, (lock) => {
      if (!lock) {
        reject(new Error('Wallet is already open in another tab'))
        return Promise.resolve()
      }
      resolve()
      // Hold the lock by returning a never-resolving promise
      return new Promise<void>(() => {})
    })
  })
}

// Deduplicate concurrent initializeLdk() calls from React StrictMode double-mount.
// The second mount reuses the in-flight promise instead of fighting for the Web Lock.
let initPromise: Promise<InitResult> | null = null

export function initializeLdk(ldkSeed: Uint8Array): Promise<InitResult> {
  if (!initPromise) {
    initPromise = doInitializeLdk(ldkSeed).catch((err) => {
      initPromise = null
      throw err
    })
  }
  return initPromise
}

async function doInitializeLdk(ldkSeed: Uint8Array): Promise<InitResult> {
  // 0. Safety: acquire multi-tab lock and init WASM
  await acquireWalletLock()
  await initWasm()

  // 1. Persist derived seed to IDB, or verify stored seed matches mnemonic derivation
  let seed = await getSeed()
  if (!seed) {
    await storeDerivedSeed(ldkSeed)
    seed = ldkSeed
  } else if (seed.length !== ldkSeed.length || !seed.every((b, i) => b === ldkSeed[i])) {
    throw new Error(
      '[LDK Init] Stored seed does not match mnemonic derivation — possible data corruption. ' +
        'Clear browser data to start fresh.',
    )
  }

  // 2. Initialize KeysManager with current timestamp for ephemeral key uniqueness
  const nowMs = Date.now()
  const startingTimeSecs = BigInt(Math.floor(nowMs / 1000))
  const startingTimeNanos = (nowMs % 1000) * 1_000_000
  const keysManager = KeysManager.constructor_new(seed, startingTimeSecs, startingTimeNanos)

  // 3. Create trait implementations
  const logger = createLogger()
  const feeEstimator = createFeeEstimator(SIGNET_CONFIG.esploraUrl)
  const broadcaster = createBroadcaster(SIGNET_CONFIG.esploraUrl)
  const { persist: persister, setChainMonitor, onPersistFailure } = createPersister()

  // 4. Create Filter + ChainMonitor
  const { filter, watchState } = createFilter()
  const chainMonitor = ChainMonitor.constructor_new(
    Option_FilterZ.constructor_some(filter),
    broadcaster,
    logger,
    feeEstimator,
    persister
  )
  setChainMonitor(chainMonitor)
  onPersistFailure(({ key, error }) => {
    console.error(`[LDK Init] CRITICAL: Persist failure for ${key}, channel operations halted`, error)
  })

  // 5. Restore or create NetworkGraph
  const ngBytes = await idbGet<Uint8Array>('ldk_network_graph', 'primary')
  let networkGraph: NetworkGraph
  if (ngBytes) {
    const result = NetworkGraph.constructor_read(ngBytes, logger)
    if (result instanceof Result_NetworkGraphDecodeErrorZ_OK) {
      networkGraph = result.res
    } else {
      console.warn('[LDK Init] Failed to restore NetworkGraph, creating fresh')
      networkGraph = NetworkGraph.constructor_new(SIGNET_CONFIG.network, logger)
    }
  } else {
    networkGraph = NetworkGraph.constructor_new(SIGNET_CONFIG.network, logger)
  }

  // 6. Restore or create Scorer
  const decayParams = ProbabilisticScoringDecayParameters.constructor_default()
  const scorerBytes = await idbGet<Uint8Array>('ldk_scorer', 'primary')
  let scorer: ProbabilisticScorer
  if (scorerBytes) {
    const result = ProbabilisticScorer.constructor_read(scorerBytes, decayParams, networkGraph, logger)
    if (result instanceof Result_ProbabilisticScorerDecodeErrorZ_OK) {
      scorer = result.res
    } else {
      console.warn('[LDK Init] Failed to restore Scorer, creating fresh')
      scorer = ProbabilisticScorer.constructor_new(decayParams, networkGraph, logger)
    }
  } else {
    scorer = ProbabilisticScorer.constructor_new(decayParams, networkGraph, logger)
  }

  // 7. Wire Router + MessageRouter
  const lockableScore = MultiThreadedLockableScore.constructor_new(scorer.as_Score())
  const router = DefaultRouter.constructor_new(
    networkGraph,
    logger,
    keysManager.as_EntropySource(),
    lockableScore.as_LockableScore(),
    ProbabilisticScoringFeeParameters.constructor_default()
  )
  const messageRouter = DefaultMessageRouter.constructor_new(
    networkGraph,
    keysManager.as_EntropySource()
  )

  // 8. Restore ChannelMonitors from IndexedDB
  const monitorEntries = await idbGetAll<Uint8Array>('ldk_channel_monitors')
  const restoredMonitors = deserializeMonitors(monitorEntries, keysManager)

  // 9. Restore or create ChannelManager
  const cmBytes = await idbGet<Uint8Array>('ldk_channel_manager', 'primary')
  let channelManager: ChannelManager

  if (cmBytes && cmBytes instanceof Uint8Array) {
    const result = UtilMethods.constructor_C2Tuple_ThirtyTwoBytesChannelManagerZ_read(
      cmBytes,
      keysManager.as_EntropySource(),
      keysManager.as_NodeSigner(),
      keysManager.as_SignerProvider(),
      feeEstimator,
      chainMonitor.as_Watch(),
      broadcaster,
      router.as_Router(),
      messageRouter.as_MessageRouter(),
      logger,
      UserConfig.constructor_default(),
      restoredMonitors
    )
    if (!(result instanceof Result_C2Tuple_ThirtyTwoBytesChannelManagerZDecodeErrorZ_OK)) {
      throw new Error('[LDK Init] Failed to deserialize ChannelManager')
    }
    channelManager = result.res.get_b()

    // Register restored monitors with ChainMonitor
    const watch = chainMonitor.as_Watch()
    for (const monitor of restoredMonitors) {
      const fundingTxo = monitor.get_funding_txo().get_a()
      watch.watch_channel(fundingTxo, monitor)
    }
  } else {
    // Orphaned monitors without a ChannelManager means channels exist but state is lost.
    // This is a fund-safety issue — halt initialization rather than silently discard.
    if (restoredMonitors.length > 0) {
      throw new Error(
        `[LDK Init] Found ${restoredMonitors.length} ChannelMonitor(s) in IndexedDB but no ChannelManager. ` +
          'This indicates corrupted state — channel funds may be at risk. ' +
          'Clear browser data to start fresh (existing channels will be lost).'
      )
    }

    // Fresh ChannelManager — fetch current chain tip from Esplora
    const esplora = new EsploraClient(SIGNET_CONFIG.esploraUrl)
    const tipHash = await esplora.getTipHash()
    const tipHeight = await esplora.getTipHeight()

    const bestBlock = BestBlock.constructor_new(hexToBytes(tipHash), tipHeight)
    const chainParams = ChainParameters.constructor_new(SIGNET_CONFIG.network, bestBlock)

    channelManager = ChannelManager.constructor_new(
      feeEstimator,
      chainMonitor.as_Watch(),
      broadcaster,
      router.as_Router(),
      messageRouter.as_MessageRouter(),
      logger,
      keysManager.as_EntropySource(),
      keysManager.as_NodeSigner(),
      keysManager.as_SignerProvider(),
      UserConfig.constructor_default(),
      chainParams,
      Math.floor(Date.now() / 1000)
    )
  }

  // 10. Create P2PGossipSync for routing message handling.
  // Even though we use RGS for bulk graph population, P2PGossipSync is needed
  // as the RoutingMessageHandler to process incremental peer gossip and signal
  // to LDK that the routing graph is available for pathfinding.
  const gossipSync = P2PGossipSync.constructor_new(
    networkGraph,
    Option_UtxoLookupZ.constructor_none(),
    logger,
  )

  // 11. Create OnionMessenger (required for BOLT 12 offers and BIP 353)
  const ignorer = IgnoringMessageHandler.constructor_new()
  const onionMessenger = OnionMessenger.constructor_new(
    keysManager.as_EntropySource(),
    keysManager.as_NodeSigner(),
    logger,
    channelManager.as_NodeIdLookUp(),
    messageRouter.as_MessageRouter(),
    channelManager.as_OffersMessageHandler(),
    channelManager.as_AsyncPaymentsMessageHandler(),
    channelManager.as_DNSResolverMessageHandler(),
    ignorer.as_CustomOnionMessageHandler()
  )

  // 12. Create PeerManager
  const peerManager = PeerManager.constructor_new(
    channelManager.as_ChannelMessageHandler(),
    gossipSync.as_RoutingMessageHandler(),
    onionMessenger.as_OnionMessageHandler(),
    ignorer.as_CustomMessageHandler(),
    Math.floor(Date.now() / 1000),
    keysManager.as_EntropySource().get_secure_random_bytes(),
    logger,
    keysManager.as_NodeSigner()
  )

  // 13. Derive node public key
  const nodeIdResult = keysManager.as_NodeSigner().get_node_id(Recipient.LDKRecipient_Node)
  if (!nodeIdResult.is_ok()) {
    throw new Error('Failed to derive node ID from KeysManager')
  }
  if (!(nodeIdResult instanceof Result_PublicKeyNoneZ_OK)) {
    throw new Error('Failed to derive node ID from KeysManager')
  }
  const nodeId = bytesToHex(nodeIdResult.res)

  // 14. Create EventHandler
  let paymentCallback: PaymentEventCallback | undefined
  const { handler: eventHandler, cleanup: cleanupEventHandler, setBdkWallet } =
    createEventHandler(
      channelManager,
      keysManager,
      (...args) => paymentCallback?.(...args),
    )

  const node: LdkNode = {
    nodeId,
    keysManager,
    logger,
    feeEstimator,
    broadcaster,
    persister,
    chainMonitor,
    channelManager,
    networkGraph,
    scorer,
    peerManager,
    onionMessenger,
    eventHandler,
  }

  return {
    node,
    watchState,
    cleanupEventHandler,
    setBdkWallet,
    setPaymentCallback: (cb: PaymentEventCallback | undefined) => {
      paymentCallback = cb
    },
  }
}

function deserializeMonitors(
  entries: Map<string, Uint8Array>,
  keysManager: KeysManager
): ChannelMonitor[] {
  const monitors: ChannelMonitor[] = []
  for (const [key, data] of entries) {
    const result = UtilMethods.constructor_C2Tuple_ThirtyTwoBytesChannelMonitorZ_read(
      data,
      keysManager.as_EntropySource(),
      keysManager.as_SignerProvider()
    )
    if (result instanceof Result_C2Tuple_ThirtyTwoBytesChannelMonitorZDecodeErrorZ_OK) {
      monitors.push(result.res.get_b())
    } else {
      throw new Error(
        `[LDK Init] Failed to deserialize ChannelMonitor "${key}". ` +
          'Channel funds may be at risk — refusing to start with incomplete state.'
      )
    }
  }
  return monitors
}
