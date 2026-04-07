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
import { idbPut } from '../../storage/idb'
import { persistChannelManager, type CmPersistContext } from '../storage/persist-cm'
import type { SyncStatus } from '../ldk-context'
import { captureError } from '../../storage/error-log'

export async function syncOnce(
  confirmables: Confirm[],
  watchState: WatchState,
  esplora: EsploraClient,
  lastSyncTipHash: string | null,
  signal?: AbortSignal
): Promise<string> {
  esplora.setSignal(signal)
  try {
    const tipHash = await esplora.getTipHash()
    if (tipHash === lastSyncTipHash) return tipHash

    // 1. Reorg detection: check get_relevant_txids() against chain
    for (const confirmable of confirmables) {
      const relevantTxids = confirmable.get_relevant_txids()
      for (const tuple of relevantTxids) {
        const txid = tuple.get_a()
        const blockHashOpt = tuple.get_c()
        if (blockHashOpt && blockHashOpt instanceof Uint8Array && blockHashOpt.length > 0) {
          const blockHashHex = txidBytesToHex(blockHashOpt)
          const status = await esplora.getBlockStatus(blockHashHex)
          if (!status.in_best_chain) {
            confirmable.transaction_unconfirmed(txid)
          }
        }
      }
    }

    // 2. Update best block — derive height from tipHash (not separate API call)
    //    to guarantee hash and height are consistent
    const tipHeight = await esplora.getBlockHeight(tipHash)
    const tipHeader = await esplora.getBlockHeader(tipHash)
    for (const confirmable of confirmables) {
      confirmable.best_block_updated(tipHeader, tipHeight)
    }

    // 3. Check watched txids for new confirmations (parallel)
    const txidEntries = [...watchState.watchedTxids.entries()]
    if (txidEntries.length > 0) {
      const txResults = await Promise.allSettled(
        txidEntries.map(async ([txidHex]) => {
          const status = await esplora.getTxStatus(txidHex)
          if (status.confirmed && status.block_hash && status.block_height != null) {
            const [header, rawTx, proof] = await Promise.all([
              esplora.getBlockHeader(status.block_hash),
              esplora.getTxHex(txidHex),
              esplora.getTxMerkleProof(txidHex, status.block_hash),
            ])
            const txdata = [TwoTuple_usizeTransactionZ.constructor_new(proof.pos, rawTx)]
            for (const confirmable of confirmables) {
              confirmable.transactions_confirmed(header, txdata, status.block_height)
            }
          }
        })
      )
      const failedTxChecks = txResults.filter((r) => r.status === 'rejected')
      if (failedTxChecks.length > 0) {
        captureError(
          'warning',
          'LDK Sync',
          `${failedTxChecks.length}/${txidEntries.length} txid checks failed`
        )
        for (const r of failedTxChecks) {
          if (r.status === 'rejected')
            captureError('error', 'LDK Sync', 'Tx check error', String(r.reason))
        }
      }
    }

    // 4. Check watched outputs for spends (parallel)
    const outputEntries = [...watchState.watchedOutputs.entries()]
    if (outputEntries.length > 0) {
      const outputResults = await Promise.allSettled(
        outputEntries.map(async ([key]) => {
          const colonIdx = key.indexOf(':')
          if (colonIdx === -1) {
            captureError('error', 'LDK Sync', `Malformed watched output key: ${key}`)
            return
          }
          const txid = key.slice(0, colonIdx)
          const vout = parseInt(key.slice(colonIdx + 1), 10)
          if (isNaN(vout)) {
            captureError('error', 'LDK Sync', `Invalid vout in watched output key: ${key}`)
            return
          }
          const spend = await esplora.getOutspend(txid, vout)
          if (spend.spent && spend.txid) {
            const status = await esplora.getTxStatus(spend.txid)
            if (status.confirmed && status.block_hash && status.block_height != null) {
              const [header, rawTx, proof] = await Promise.all([
                esplora.getBlockHeader(status.block_hash),
                esplora.getTxHex(spend.txid),
                esplora.getTxMerkleProof(spend.txid, status.block_hash),
              ])
              const txdata = [TwoTuple_usizeTransactionZ.constructor_new(proof.pos, rawTx)]
              for (const confirmable of confirmables) {
                confirmable.transactions_confirmed(header, txdata, status.block_height)
              }
            }
          }
        })
      )
      const failedOutputChecks = outputResults.filter((r) => r.status === 'rejected')
      if (failedOutputChecks.length > 0) {
        captureError(
          'warning',
          'LDK Sync',
          `${failedOutputChecks.length}/${outputEntries.length} output checks failed`
        )
        for (const r of failedOutputChecks) {
          if (r.status === 'rejected')
            captureError('error', 'LDK Sync', 'Output check error', String(r.reason))
        }
      }
    }

    // 5. Prune confirmed items no longer tracked by LDK
    const allRelevantTxids = new Set<string>()
    for (const confirmable of confirmables) {
      for (const tuple of confirmable.get_relevant_txids()) {
        allRelevantTxids.add(txidBytesToHex(tuple.get_a()))
      }
    }
    for (const txid of watchState.watchedTxids.keys()) {
      if (!allRelevantTxids.has(txid)) {
        watchState.watchedTxids.delete(txid)
      }
    }

    return tipHash
  } finally {
    esplora.setSignal(undefined)
  }
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
  onStatusChange?: (status: SyncStatus) => void
  cmPersistCtx?: CmPersistContext
}

const MAX_BACKOFF_MS = 5 * 60 * 1_000 // 5 minutes
const STALE_THRESHOLD = 3 // consecutive errors before 'stale'
const SYNC_TIMEOUT_MS = 60_000

export function startSyncLoop(config: SyncLoopConfig): SyncLoopHandle {
  let lastTipHash: string | null = null
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let tickCount = 0
  let cmNeedsPersist = false
  let rgsHandle: RgsHandle | null = null
  let rgsInitStarted = false
  let consecutiveErrors = 0
  let currentBackoff = config.intervalMs

  async function ensureRgs() {
    if (!config.rgsUrl || rgsHandle || rgsInitStarted) return
    rgsInitStarted = true
    try {
      rgsHandle = await initRapidGossipSync(config.networkGraph, config.logger, config.rgsUrl)
      console.log('[LDK Sync] Rapid Gossip Sync initialized')
    } catch (err) {
      captureError('warning', 'LDK Sync', 'RGS init failed, will retry', String(err))
      rgsInitStarted = false // allow retry on next tick
    }
  }

  async function tick() {
    if (stopped) return
    try {
      // Initialize RGS concurrently — don't block chain sync on gossip fetch
      void ensureRgs()

      const controller = new AbortController()
      const syncTimeout = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS)
      try {
        lastTipHash = await syncOnce(
          config.confirmables,
          config.watchState,
          config.esplora,
          lastTipHash,
          controller.signal
        )
      } catch (err) {
        // Reset lastTipHash on timeout to force full retry next tick
        if (controller.signal.aborted) lastTipHash = null
        throw err
      } finally {
        clearTimeout(syncTimeout)
      }

      config.channelManager.timer_tick_occurred()
      config.chainMonitor.rebroadcast_pending_claims()

      // Persist ChannelManager if needed (cmNeedsPersist retries after prior failure)
      if (cmNeedsPersist || config.channelManager.get_and_clear_needs_persistence()) {
        cmNeedsPersist = false
        try {
          await persistChannelManager(config.channelManager, config.cmPersistCtx)
        } catch (err: unknown) {
          cmNeedsPersist = true
          throw err
        }
      }

      // Persist NetworkGraph + Scorer every ~10 ticks (~10 min at 60s interval)
      if ((tickCount + 1) % 10 === 0) {
        await idbPut('ldk_network_graph', 'primary', config.networkGraph.write())
        await idbPut('ldk_scorer', 'primary', config.scorer.write())
      }

      // Periodic RGS delta sync — persist graph immediately after to keep
      // timestamp and graph in sync (prevents data gap if browser crashes)
      const rgsInterval = config.rgsSyncIntervalTicks ?? 60
      if (rgsHandle && config.rgsUrl && (tickCount + 1) % rgsInterval === 0) {
        try {
          await syncRapidGossip(rgsHandle, config.rgsUrl)
          await idbPut('ldk_network_graph', 'primary', config.networkGraph.write())
        } catch (err) {
          captureError('warning', 'LDK Sync', 'RGS periodic sync failed', String(err))
        }
      }

      tickCount++
      consecutiveErrors = 0
      currentBackoff = config.intervalMs
      config.onStatusChange?.('synced')
    } catch (err) {
      captureError('error', 'LDK Sync', 'Sync error', String(err))
      consecutiveErrors++
      currentBackoff = Math.min(currentBackoff * 2, MAX_BACKOFF_MS)
      if (consecutiveErrors >= STALE_THRESHOLD) {
        config.onStatusChange?.('stale')
      }
    }

    if (!stopped) {
      timeoutId = setTimeout(tick, currentBackoff)
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
