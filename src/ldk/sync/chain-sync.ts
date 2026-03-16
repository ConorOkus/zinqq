import {
  TwoTuple_usizeTransactionZ,
  type Confirm,
  type ChannelManager,
  type ChainMonitor,
  type NetworkGraph,
  type Logger,
  type ProbabilisticScorer,
} from 'lightningdevkit'
import type { EsploraClient } from './esplora-client'
import type { WatchState } from '../traits/filter'
import { initRapidGossipSync, syncRapidGossip, type RgsHandle } from './rapid-gossip-sync'
import { txidBytesToHex } from '../utils'
import { idbPut } from '../storage/idb'

export async function syncOnce(
  confirmables: Confirm[],
  watchState: WatchState,
  esplora: EsploraClient,
  lastSyncTipHash: string | null
): Promise<string> {
  const tipHash = await esplora.getTipHash()
  if (tipHash === lastSyncTipHash) return tipHash

  // 1. Reorg detection: check get_relevant_txids() against chain
  for (const confirmable of confirmables) {
    const relevantTxids = confirmable.get_relevant_txids()
    for (const tuple of relevantTxids) {
      const txid = tuple.get_a()
      const blockHashOpt = tuple.get_c()
      if (blockHashOpt && blockHashOpt.length > 0) {
        const blockHashHex = txidBytesToHex(blockHashOpt)
        const status = await esplora.getBlockStatus(blockHashHex)
        if (!status.in_best_chain) {
          confirmable.transaction_unconfirmed(txid)
        }
      }
    }
  }

  // 2. Update best block
  const tipHeight = await esplora.getTipHeight()
  const tipHeader = await esplora.getBlockHeader(tipHash)
  for (const confirmable of confirmables) {
    confirmable.best_block_updated(tipHeader, tipHeight)
  }

  // 3. Check watched txids for new confirmations
  for (const [txidHex] of watchState.watchedTxids) {
    const status = await esplora.getTxStatus(txidHex)
    if (status.confirmed && status.block_hash && status.block_height != null) {
      const header = await esplora.getBlockHeader(status.block_hash)
      const rawTx = await esplora.getTxHex(txidHex)
      const proof = await esplora.getTxMerkleProof(txidHex)
      const txdata = [TwoTuple_usizeTransactionZ.constructor_new(proof.pos, rawTx)]
      for (const confirmable of confirmables) {
        confirmable.transactions_confirmed(header, txdata, status.block_height)
      }
    }
  }

  // 4. Check watched outputs for spends
  for (const [key] of watchState.watchedOutputs) {
    const colonIdx = key.indexOf(':')
    if (colonIdx === -1) {
      console.error(`[LDK Sync] Malformed watched output key: ${key}`)
      continue
    }
    const txid = key.slice(0, colonIdx)
    const vout = parseInt(key.slice(colonIdx + 1), 10)
    if (isNaN(vout)) {
      console.error(`[LDK Sync] Invalid vout in watched output key: ${key}`)
      continue
    }
    const spend = await esplora.getOutspend(txid, vout)
    if (spend.spent && spend.txid) {
      const status = await esplora.getTxStatus(spend.txid)
      if (status.confirmed && status.block_hash && status.block_height != null) {
        const header = await esplora.getBlockHeader(status.block_hash)
        const rawTx = await esplora.getTxHex(spend.txid)
        const proof = await esplora.getTxMerkleProof(spend.txid)
        const txdata = [TwoTuple_usizeTransactionZ.constructor_new(proof.pos, rawTx)]
        for (const confirmable of confirmables) {
          confirmable.transactions_confirmed(header, txdata, status.block_height)
        }
      }
    }
  }

  // 5. Verify tip didn't change mid-sync
  const postSyncTip = await esplora.getTipHash()
  if (postSyncTip !== tipHash) {
    console.warn('[LDK Sync] Tip changed during sync, will retry next tick')
  }

  return tipHash
}

export interface SyncLoopHandle {
  stop: () => void
}

export interface SyncLoopConfig {
  confirmables: Confirm[]
  watchState: WatchState
  esplora: EsploraClient
  channelManager: ChannelManager
  chainMonitor: ChainMonitor
  networkGraph: NetworkGraph
  logger: Logger
  scorer: ProbabilisticScorer
  intervalMs: number
  rgsUrl?: string
  rgsSyncIntervalTicks?: number
}

export function startSyncLoop(config: SyncLoopConfig): SyncLoopHandle {
  let lastTipHash: string | null = null
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let tickCount = 0
  let cmNeedsPersist = false
  let rgsHandle: RgsHandle | null = null
  let rgsInitStarted = false

  async function ensureRgs() {
    if (!config.rgsUrl || rgsHandle || rgsInitStarted) return
    rgsInitStarted = true
    try {
      rgsHandle = await initRapidGossipSync(
        config.networkGraph,
        config.logger,
        config.rgsUrl,
      )
      console.log('[LDK Sync] Rapid Gossip Sync initialized')
    } catch (err) {
      console.warn('[LDK Sync] RGS init failed, will retry:', err)
      rgsInitStarted = false // allow retry on next tick
    }
  }

  async function tick() {
    if (stopped) return
    try {
      // Initialize RGS concurrently — don't block chain sync on gossip fetch
      void ensureRgs()

      lastTipHash = await syncOnce(
        config.confirmables,
        config.watchState,
        config.esplora,
        lastTipHash,
      )

      config.channelManager.timer_tick_occurred()
      config.chainMonitor.rebroadcast_pending_claims()

      // Persist ChannelManager if needed (cmNeedsPersist retries after prior idbPut failure)
      if (cmNeedsPersist || config.channelManager.get_and_clear_needs_persistence()) {
        cmNeedsPersist = false
        try {
          await idbPut('ldk_channel_manager', 'primary', config.channelManager.write())
        } catch (err: unknown) {
          cmNeedsPersist = true
          throw err
        }
      }

      // Persist NetworkGraph + Scorer every ~10 ticks (~5 min at 30s interval)
      if ((tickCount + 1) % 10 === 0) {
        await idbPut('ldk_network_graph', 'primary', config.networkGraph.write())
        await idbPut('ldk_scorer', 'primary', config.scorer.write())
      }

      // Periodic RGS delta sync — persist graph immediately after to keep
      // timestamp and graph in sync (prevents data gap if browser crashes)
      const rgsInterval = config.rgsSyncIntervalTicks ?? 20
      if (rgsHandle && config.rgsUrl && (tickCount + 1) % rgsInterval === 0) {
        try {
          await syncRapidGossip(rgsHandle, config.rgsUrl)
          await idbPut('ldk_network_graph', 'primary', config.networkGraph.write())
        } catch (err) {
          console.warn('[LDK Sync] RGS periodic sync failed:', err)
        }
      }

      tickCount++
    } catch (err) {
      console.error('[LDK Sync] Sync error:', err)
    }

    if (!stopped) {
      timeoutId = setTimeout(tick, config.intervalMs)
    }
  }

  // Start first tick immediately (fire-and-forget, errors caught inside tick)
  void tick()

  return {
    stop: () => {
      stopped = true
      if (timeoutId !== null) clearTimeout(timeoutId)
    },
  }
}
