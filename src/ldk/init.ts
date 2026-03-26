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
  type SignerProvider,
} from 'lightningdevkit'
import { getSeed, storeDerivedSeed } from './storage/seed'
import { createLogger } from './traits/logger'
import { createFeeEstimator } from './traits/fee-estimator'
import { createBroadcaster } from './traits/broadcaster'
import {
  createPersister,
  MONITOR_MANIFEST_KEY,
  parseMonitorManifest,
  type PersisterOptions,
} from './traits/persist'
import { createFilter, type WatchState } from './traits/filter'
import {
  createEventHandler,
  type PaymentEventCallback,
  type ChannelClosedCallback,
  type SyncNeededCallback,
} from './traits/event-handler'
import { createBdkSignerProvider } from './traits/bdk-signer-provider'
import { SIGNET_CONFIG } from './config'
import { ONCHAIN_CONFIG } from '../onchain/config'
import { initializeBdkWalletEager } from '../onchain/init'
import { idbGet, idbGetAll, idbPut, idbDelete, idbDeleteBatch } from '../storage/idb'
import { bytesToHex, hexToBytes } from './utils'
import {
  KNOWN_PEERS_VSS_KEY,
  getKnownPeers,
  parseKnownPeers,
  setKnownPeersVssClient,
} from './storage/known-peers'
import { EsploraClient } from './sync/esplora-client'
import type { VssClient } from './storage/vss-client'

import type { CmPersistContext } from './storage/persist-cm'

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
  bdkWallet: import('@bitcoindevkit/bdk-wallet-web').Wallet
  bdkEsploraClient: import('@bitcoindevkit/bdk-wallet-web').EsploraClient
  setPaymentCallback: (cb: PaymentEventCallback | undefined) => void
  setChannelClosedCallback: (cb: ChannelClosedCallback | undefined) => void
  setSyncNeededCallback: (cb: SyncNeededCallback | undefined) => void
  cmPersistCtx: CmPersistContext
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
        'A modern browser with Web Locks support is required to prevent multi-tab fund loss.'
    )
  }

  return new Promise<void>((resolve, reject) => {
    void navigator.locks.request('zinq-lock', { ifAvailable: true }, (lock) => {
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

export interface InitOptions {
  ldkSeed: Uint8Array
  bdkDescriptors: { external: string; internal: string }
  vssClient?: VssClient | null
  persisterOptions?: PersisterOptions
}

export function initializeLdk(options: InitOptions): Promise<InitResult> {
  if (!initPromise) {
    initPromise = doInitializeLdk(options).catch((err) => {
      initPromise = null
      throw err
    })
  }
  return initPromise
}

async function doInitializeLdk(options: InitOptions): Promise<InitResult> {
  const { ldkSeed, bdkDescriptors, vssClient, persisterOptions } = options
  // 0. Safety: acquire multi-tab lock and init WASM
  await acquireWalletLock()
  await initWasm()

  // 0.5 Initialize BDK wallet eagerly (no chain scan) so it's available
  // for address derivation during ChannelManager/ChannelMonitor deserialization
  const { wallet: bdkWallet, esploraClient: bdkEsploraClient } = await initializeBdkWalletEager(
    bdkDescriptors,
    ONCHAIN_CONFIG.network
  )

  // 1. Persist derived seed to IDB, or verify stored seed matches mnemonic derivation
  let seed = await getSeed()
  if (!seed) {
    await storeDerivedSeed(ldkSeed)
    seed = ldkSeed
  } else if (seed.length !== ldkSeed.length || !seed.every((b, i) => b === ldkSeed[i])) {
    throw new Error(
      '[LDK Init] Stored seed does not match mnemonic derivation — possible data corruption. ' +
        'Clear browser data to start fresh.'
    )
  }

  // 2. Initialize KeysManager with current timestamp for ephemeral key uniqueness.
  // The timestamp only seeds generate_channel_keys_id for NEW channels.
  // Existing channels carry their channel_keys_id in serialized data and
  // re-derive keys from seed + channel_keys_id (timestamp-independent).
  const nowMs = Date.now()
  const startingTimeSecs = BigInt(Math.floor(nowMs / 1000))
  const startingTimeNanos = (nowMs % 1000) * 1_000_000
  const keysManager = KeysManager.constructor_new(seed, startingTimeSecs, startingTimeNanos)
  seed.fill(0) // Zero seed bytes after KeysManager copies them

  // Custom SignerProvider that directs close/sweep funds to the BDK wallet.
  // BDK wallet is available eagerly so get_destination_script can derive
  // addresses deterministically during deserialization.
  const { signerProvider: bdkSignerProvider } = createBdkSignerProvider(keysManager, bdkWallet)

  // 3. Create trait implementations
  const logger = createLogger()
  const feeEstimator = createFeeEstimator(SIGNET_CONFIG.esploraUrl)
  const broadcaster = createBroadcaster(SIGNET_CONFIG.esploraUrl)

  // 3.5 VSS Recovery: if IDB is empty but VSS has data, download state
  let initialMonitorKeys: string[] = []
  const recoveredVersions = new Map<string, number>()
  let initialCmVersion = 0
  if (vssClient) {
    const idbMonitors = await idbGetAll('ldk_channel_monitors')
    const idbCm = await idbGet('ldk_channel_manager', 'primary')

    if (idbMonitors.size === 0 && !idbCm) {
      const writtenMonitorKeys: string[] = []
      let wroteChannelManager = false
      try {
        const manifest = await vssClient.getObject(MONITOR_MANIFEST_KEY)
        if (manifest) {
          const monitorKeys = parseMonitorManifest(new TextDecoder().decode(manifest.value))

          for (const key of monitorKeys) {
            const obj = await vssClient.getObject(key)
            if (!obj) throw new Error(`Monitor "${key}" listed in manifest but missing from VSS`)
            // Validate the blob deserializes before persisting to IDB
            const readResult = UtilMethods.constructor_C2Tuple_ThirtyTwoBytesChannelMonitorZ_read(
              obj.value,
              keysManager.as_EntropySource(),
              bdkSignerProvider
            )
            if (
              !(readResult instanceof Result_C2Tuple_ThirtyTwoBytesChannelMonitorZDecodeErrorZ_OK)
            ) {
              throw new Error(`Monitor "${key}" from VSS failed deserialization — data is corrupt`)
            }
            await idbPut('ldk_channel_monitors', key, obj.value)
            writtenMonitorKeys.push(key)
            recoveredVersions.set(key, obj.version)
          }

          const cm = await vssClient.getObject('channel_manager')
          if (!cm) throw new Error('ChannelManager missing from VSS')
          // Basic sanity: LDK ChannelManager serialization has a minimum viable size
          if (cm.value.byteLength < 32) {
            throw new Error(
              `ChannelManager from VSS is too small (${cm.value.byteLength} bytes) — likely corrupt`
            )
          }
          await idbPut('ldk_channel_manager', 'primary', cm.value)
          wroteChannelManager = true
          initialCmVersion = cm.version

          // Recover known peers if available
          const peersObj = await vssClient.getObject(KNOWN_PEERS_VSS_KEY)
          if (peersObj) {
            const peers = parseKnownPeers(new TextDecoder().decode(peersObj.value))
            for (const [pubkey, peer] of peers) {
              await idbPut('ldk_known_peers', pubkey, peer)
            }
            recoveredVersions.set(KNOWN_PEERS_VSS_KEY, peersObj.version)
            console.log(`[LDK Init] Recovered ${peers.size} known peer(s) from VSS`)
          }

          recoveredVersions.set(MONITOR_MANIFEST_KEY, manifest.version)
          initialMonitorKeys = monitorKeys
          console.log(`[LDK Init] Recovered ${monitorKeys.length} monitor(s) + CM from VSS`)
        }
      } catch (err: unknown) {
        // Roll back partial IDB writes so the app can start fresh
        if (writtenMonitorKeys.length > 0 || wroteChannelManager) {
          console.warn('[LDK Init] VSS recovery failed, rolling back partial IDB writes')
          await idbDeleteBatch('ldk_channel_monitors', writtenMonitorKeys).catch(() => {})
          if (wroteChannelManager) await idbDelete('ldk_channel_manager', 'primary').catch(() => {})
        }
        recoveredVersions.clear()
        initialCmVersion = 0
        console.warn('[LDK Init] VSS recovery failed, continuing with fresh state:', err)
      }
    } else {
      initialMonitorKeys = [...idbMonitors.keys()]
    }
  }

  const {
    persist: persister,
    setChainMonitor,
    onPersistFailure,
    backfillManifest,
    versionCache,
  } = createPersister({
    ...persisterOptions,
    initialMonitorKeys,
  })

  // Seed version cache from recovery so first post-recovery writes don't trigger conflicts
  for (const [key, version] of recoveredVersions) {
    versionCache.set(key, version)
  }

  // Wire known-peers VSS sync, seeded from recovery version if available
  setKnownPeersVssClient(vssClient ?? null, recoveredVersions.get(KNOWN_PEERS_VSS_KEY) ?? 0)

  // Backfill manifest to VSS for wallets that predate the manifest feature.
  // Fire-and-forget: the persister's writeManifest will keep it in sync going forward.
  backfillManifest()

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
    console.error(
      `[LDK Init] CRITICAL: Persist failure for ${key}, channel operations halted`,
      error
    )
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
    const result = ProbabilisticScorer.constructor_read(
      scorerBytes,
      decayParams,
      networkGraph,
      logger
    )
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
  const restoredMonitors = deserializeMonitors(monitorEntries, keysManager, bdkSignerProvider)

  // 9. Restore or create ChannelManager
  const cmBytes = await idbGet<Uint8Array>('ldk_channel_manager', 'primary')
  let channelManager: ChannelManager | null = null

  if (cmBytes instanceof Uint8Array) {
    const result = UtilMethods.constructor_C2Tuple_ThirtyTwoBytesChannelManagerZ_read(
      cmBytes,
      keysManager.as_EntropySource(),
      keysManager.as_NodeSigner(),
      bdkSignerProvider,
      feeEstimator,
      chainMonitor.as_Watch(),
      broadcaster,
      router.as_Router(),
      messageRouter.as_MessageRouter(),
      logger,
      UserConfig.constructor_default(),
      restoredMonitors
    )
    if (result instanceof Result_C2Tuple_ThirtyTwoBytesChannelManagerZDecodeErrorZ_OK) {
      channelManager = result.res.get_b()
    } else if (restoredMonitors.length === 0) {
      // Defense-in-depth: if deserialization fails (e.g., stale CM from a
      // previous wallet that survived an IDB clear race), discard and create
      // fresh rather than crashing. Only safe when there are no monitors.
      console.warn(
        '[LDK Init] ChannelManager deserialization failed with no monitors — ' +
          'discarding stale CM and creating fresh. This can happen after a wallet restore.'
      )
      await idbDelete('ldk_channel_manager', 'primary')
    } else {
      throw new Error('[LDK Init] Failed to deserialize ChannelManager')
    }
  }

  if (channelManager) {
    const restoredChannels = channelManager.list_channels()
    console.log(
      `[LDK Init] Restored ChannelManager from IDB with ${restoredMonitors.length} monitor(s) and ${restoredChannels.length} channel(s)`
    )
    for (const ch of restoredChannels) {
      console.log(
        `[LDK Init]   channel ${bytesToHex(ch.get_channel_id().write()).substring(0, 16)}... ` +
          `peer=${bytesToHex(ch.get_counterparty().get_node_id()).substring(0, 16)}... ` +
          `ready=${ch.get_is_channel_ready()} usable=${ch.get_is_usable()} ` +
          `capacity=${ch.get_channel_value_satoshis()} sats`
      )
    }
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
    const tipHeight = await esplora.getBlockHeight(tipHash)

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
      bdkSignerProvider,
      UserConfig.constructor_default(),
      chainParams,
      Math.floor(Date.now() / 1000)
    )
    console.log('[LDK Init] Created fresh ChannelManager (no persisted state found in IDB)')
  }

  // 10. Create P2PGossipSync for routing message handling.
  // Even though we use RGS for bulk graph population, P2PGossipSync is needed
  // as the RoutingMessageHandler to process incremental peer gossip and signal
  // to LDK that the routing graph is available for pathfinding.
  const gossipSync = P2PGossipSync.constructor_new(
    networkGraph,
    Option_UtxoLookupZ.constructor_none(),
    logger
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
  let channelClosedCallback: ChannelClosedCallback | undefined
  let syncNeededCallback: SyncNeededCallback | undefined
  const { handler: eventHandler, cleanup: cleanupEventHandler } = createEventHandler(
    channelManager,
    keysManager,
    bdkWallet,
    (...args) => paymentCallback?.(...args),
    (...args) => channelClosedCallback?.(...args),
    () => syncNeededCallback?.()
  )

  // ChannelManager VSS version ref — seeded from recovery or migration, updated by persistChannelManager
  const cmVersionRef = { current: initialCmVersion }
  const cmPersistCtx: CmPersistContext = {
    vssClient: vssClient ?? null,
    cmVersionRef,
  }

  // Migration for existing users: if IDB has channel state but VSS has none,
  // upload existing state. listKeyVersions returns obfuscated keys, so we use
  // it only to detect whether VSS has any data for this wallet.
  if (vssClient && restoredMonitors.length > 0) {
    try {
      const vssKeys = await vssClient.listKeyVersions()
      if (vssKeys.length === 0) {
        console.log('[LDK Init] Migrating existing IDB state to VSS...')
        const items: Array<{ key: string; value: Uint8Array; version: number }> = []

        // Upload ChannelManager
        if (cmBytes && cmBytes instanceof Uint8Array) {
          items.push({ key: 'channel_manager', value: cmBytes, version: 0 })
        }

        // Upload all ChannelMonitors
        for (const [key, data] of monitorEntries) {
          items.push({ key, value: data, version: 0 })
        }

        // Include the monitor manifest in the migration
        const manifestKeys = [...monitorEntries.keys()]
        const manifestValue = new TextEncoder().encode(JSON.stringify(manifestKeys))
        items.push({ key: MONITOR_MANIFEST_KEY, value: manifestValue, version: 0 })

        // Include known peers in the migration
        const knownPeers = await getKnownPeers()
        if (knownPeers.size > 0) {
          const peersObj = Object.fromEntries(knownPeers)
          const peersValue = new TextEncoder().encode(JSON.stringify(peersObj))
          items.push({ key: KNOWN_PEERS_VSS_KEY, value: peersValue, version: 0 })
        }

        if (items.length > 0) {
          await vssClient.putObjects(items)
          // Seed version refs — putObjects writes version 0, server increments to 1
          cmVersionRef.current = 1
          for (const [key] of monitorEntries) {
            versionCache.set(key, 1)
          }
          versionCache.set(MONITOR_MANIFEST_KEY, 1)
          if (knownPeers.size > 0) {
            setKnownPeersVssClient(vssClient, 1)
          }
          console.log(`[LDK Init] Migrated ${items.length} item(s) to VSS`)
        }
      }
    } catch (err: unknown) {
      // Migration failure is non-fatal — VSS writes will begin on next persist
      console.warn('[LDK Init] VSS migration failed (will retry on next startup):', err)
    }
  }

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
    bdkWallet,
    bdkEsploraClient,
    setPaymentCallback: (cb: PaymentEventCallback | undefined) => {
      paymentCallback = cb
    },
    setChannelClosedCallback: (cb: ChannelClosedCallback | undefined) => {
      channelClosedCallback = cb
    },
    setSyncNeededCallback: (cb: SyncNeededCallback | undefined) => {
      syncNeededCallback = cb
    },
    cmPersistCtx,
  }
}

function deserializeMonitors(
  entries: Map<string, Uint8Array>,
  keysManager: KeysManager,
  signerProvider: SignerProvider
): ChannelMonitor[] {
  const monitors: ChannelMonitor[] = []
  for (const [key, data] of entries) {
    const result = UtilMethods.constructor_C2Tuple_ThirtyTwoBytesChannelMonitorZ_read(
      data,
      keysManager.as_EntropySource(),
      signerProvider
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
