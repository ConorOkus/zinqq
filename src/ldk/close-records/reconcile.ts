/**
 * Reconciliation pass — the load-bearing healer for close records.
 *
 * Covers: tab closed for the whole timelock, sweeps executed on another
 * device, crashes between the event handler's ok() and the async persist,
 * and dropped events. Runs on the sync tick (wired via chain-sync's
 * onSynced extension point), gated so the steady state with no pending
 * closes costs zero network and WASM work.
 *
 * Completion requires POSITIVE evidence — funds visible in our own BDK
 * wallet with ≥6 confs (LDK ANTI_REORG_DELAY), or nothing to receive and
 * the close tx deeply confirmed. Absence from balance APIs is never
 * evidence (the monitor may be archived or unrestored). Esplora errors
 * leave records stale for the next pass; they never complete anything.
 *
 * Note (recorded in the plan): per-monitor balance reads are closed off in
 * the 0.2.4-0 bindings (LockedChannelMonitor exposes only free()), so this
 * pass leans on funding-outspend discovery + BDK receipt evidence instead
 * of monitor resolution status. The auto-reopen escape hatch is deferred
 * for the same reason — flat get_claimable_balances carries no channel
 * attribution to reopen from.
 */

import { Txid, type Wallet } from '@bitcoindevkit/bdk-wallet-web'
import type { ChannelManager } from 'lightningdevkit'
import { idbGetAll } from '../../storage/idb'
import type { EsploraClient } from '../sync/esplora-client'
import type { SpendableOutputsEntry } from '../sweep'
import { bytesToHex } from '../utils'
import { captureError } from '../../storage/error-log'
import { CLOSE_RECORD_SCHEMA_VERSION, type CloseRecord } from './close-record'
import {
  getCloseRecordSync,
  getCloseRecordsSnapshot,
  getFundingTxoMap,
  removeFundingTxo,
  setLastKnownTipHeight,
  upsertCloseRecord,
} from './store'

/** LDK's ANTI_REORG_DELAY: a tx is final for our purposes at 6 confirmations. */
const FINALITY_CONFS = 6
/**
 * Upper bound on to_self_delay (matches LSPS2 max_client_to_self_delay, ~14
 * days). Terminal-state fallback for force closes whose actual timelock was
 * never captured — every record must reach a terminal state in bounded time.
 */
const MAX_TIMELOCK_BLOCKS = 2016
/** Esplora shares a 2-slot semaphore with LDK-critical sync — stay polite. */
const MAX_QUERIES_PER_PASS = 8

export interface ReconcileDeps {
  channelManager: ChannelManager
  /** MUST be the first-party proxy client — never the mempool.space fallback
   * (recurring outspend polling of channel outpoints through a third party
   * would leak the user's IP + entire channel set). */
  esplora: EsploraClient
  bdkWallet: Wallet
}

let reconcileInProgress = false

function confirmations(tipHeight: number, confirmedAtHeight: number): number {
  return tipHeight - confirmedAtHeight + 1
}

function txConfirmedInWallet(bdkWallet: Wallet, txidHex: string): boolean {
  try {
    const wtx = bdkWallet.get_tx(Txid.from_string(txidHex))
    return wtx != null && wtx.chain_position.is_confirmed
  } catch {
    return false
  }
}

async function pendingSpendableChannels(): Promise<Set<string>> {
  const pending = new Set<string>()
  try {
    const entries = await idbGetAll<Uint8Array[] | SpendableOutputsEntry>('ldk_spendable_outputs')
    for (const entry of entries.values()) {
      if (!Array.isArray(entry) && entry.channelIdHex) pending.add(entry.channelIdHex)
    }
  } catch (err: unknown) {
    captureError('warning', 'CloseRecords', 'Reconcile: spendable-outputs read failed', String(err))
  }
  return pending
}

export async function reconcileCloseRecords(
  deps: ReconcileDeps,
  info: { tipChanged: boolean; tipHash: string }
): Promise<void> {
  if (reconcileInProgress) return
  const pendingRecords = getCloseRecordsSnapshot().filter((r) => r.completedAt === undefined)
  const fundingMap = getFundingTxoMap()

  // Mempool-window exception: while a record's closing tx is undiscovered,
  // check its funding outspend every tick (Esplora reports unconfirmed
  // spends). Everything else only moves when a new block arrives.
  const undiscovered = pendingRecords.filter(
    (r) => r.fundingTxo && !r.txs.some((tx) => tx.role === 'closing' || tx.role === 'commitment')
  )
  if (!info.tipChanged && undiscovered.length === 0) return
  if (pendingRecords.length === 0 && fundingMap.size === 0) return

  reconcileInProgress = true
  try {
    let queryBudget = MAX_QUERIES_PER_PASS
    const spendQuery = async <T>(fn: () => Promise<T>): Promise<T | null> => {
      if (queryBudget <= 0) return null
      queryBudget -= 1
      return fn()
    }

    // 1. Create records for channels that vanished recordless (crash between
    //    ok() and the record persist). The funding-txo map is the safety net.
    if (info.tipChanged && fundingMap.size > 0) {
      const openIds = new Set(
        deps.channelManager.list_channels().map((ch) => bytesToHex(ch.get_channel_id().write()))
      )
      for (const [channelId, txo] of fundingMap) {
        if (openIds.has(channelId)) continue
        if (getCloseRecordSync(channelId)) {
          void removeFundingTxo(channelId)
          continue
        }
        const record: CloseRecord = {
          schemaVersion: CLOSE_RECORD_SCHEMA_VERSION,
          channelId,
          fundingTxo: { txid: txo.txid, vout: txo.vout },
          closeType: 'unknown',
          initiator: 'unknown',
          closureReason: 'Channel closed while the app was offline',
          txs: [],
          ...(txo.timelockBlocks !== undefined ? { timelockBlocks: txo.timelockBlocks } : {}),
          createdAt: Date.now(),
        }
        void upsertCloseRecord(record)
        void removeFundingTxo(channelId)
      }
    }

    const toProcess = getCloseRecordsSnapshot().filter((r) => r.completedAt === undefined)
    if (toProcess.length === 0) return

    const tipHeight = await deps.esplora.getBlockHeight(info.tipHash)
    setLastKnownTipHeight(tipHeight)
    const pendingSpendables = info.tipChanged ? await pendingSpendableChannels() : new Set<string>()

    for (const record of toProcess) {
      // Per-record isolation: an Esplora ERROR skips the record (stale, healed
      // next pass) — it must never read as "no spends" and complete anything.
      try {
        const facts: CloseRecord = {
          schemaVersion: CLOSE_RECORD_SCHEMA_VERSION,
          channelId: record.channelId,
          closeType: 'unknown',
          initiator: 'unknown',
          txs: [],
          createdAt: record.createdAt,
        }
        let changed = false

        // (a) Discover the closing tx from the funding outspend.
        const hasCloseTx = record.txs.some(
          (tx) => tx.role === 'closing' || tx.role === 'commitment'
        )
        if (!hasCloseTx && record.fundingTxo) {
          const txo = record.fundingTxo
          const spend = await spendQuery(() => deps.esplora.getOutspend(txo.txid, txo.vout))
          if (spend?.spent && spend.txid) {
            const status = await spendQuery(() => deps.esplora.getTxStatus(spend.txid!))
            facts.txs.push({
              txid: spend.txid,
              role: record.closeType === 'coop' ? 'closing' : 'commitment',
              ...(status?.confirmed && status.block_height != null
                ? { confirmedAtHeight: status.block_height }
                : {}),
            })
            changed = true
          }
        }

        // (b) Write-once confirmation heights for known txs (new-tip only).
        if (info.tipChanged) {
          for (const tx of record.txs) {
            if (tx.confirmedAtHeight !== undefined) continue
            const status = await spendQuery(() => deps.esplora.getTxStatus(tx.txid))
            if (status?.confirmed && status.block_height != null) {
              facts.txs.push({ ...tx, confirmedAtHeight: status.block_height })
              changed = true
            }
          }
        }

        // (b2) Derive the timelock expiry height once the close tx confirms.
        // to_self_delay was captured while the channel was open (safety-net
        // map → record fact); the close tx's confirm height may have been
        // discovered in this very pass, so check both fact sets.
        if (
          record.claimableAtHeight === undefined &&
          record.timelockBlocks !== undefined &&
          record.closeType !== 'coop'
        ) {
          const closeConfirmedAt = [...facts.txs, ...record.txs].find(
            (tx) =>
              (tx.role === 'commitment' || tx.role === 'closing') &&
              tx.confirmedAtHeight !== undefined
          )?.confirmedAtHeight
          if (closeConfirmedAt !== undefined) {
            facts.claimableAtHeight = closeConfirmedAt + record.timelockBlocks
            changed = true
          }
        }

        if (changed) void upsertCloseRecord(facts)

        // (c) Positive-evidence completion (new-tip only).
        if (!info.tipChanged) continue
        const current = getCloseRecordSync(record.channelId) ?? record
        const claimGate =
          current.claimableAtHeight === undefined || current.claimableAtHeight <= tipHeight
        if (!claimGate || pendingSpendables.has(current.channelId)) continue

        const deepConf = (h: number | undefined): boolean =>
          h !== undefined && confirmations(tipHeight, h) >= FINALITY_CONFS
        const closeTx = current.txs.find((tx) => tx.role === 'closing' || tx.role === 'commitment')
        const closeFinal = deepConf(closeTx?.confirmedAtHeight)
        // 'commitment' is a valid receipt role: safety-net records (closeType
        // 'unknown') label the discovered close tx 'commitment' even when it
        // was actually a coop close paying this wallet directly. The wallet
        // check is the real gate — a force-close commitment never pays the
        // BDK wallet, so it can't false-positive.
        const receiptTx = current.txs.find(
          (tx) =>
            (tx.role === 'sweep' || tx.role === 'closing' || tx.role === 'commitment') &&
            deepConf(tx.confirmedAtHeight) &&
            txConfirmedInWallet(deps.bdkWallet, tx.txid)
        )

        if (receiptTx) {
          void upsertCloseRecord({
            ...facts,
            txs: [],
            completedAt: Date.now(),
            resolution: 'verified',
          })
        } else if (current.expectedAmountSats === 0n && closeFinal) {
          // Nothing to receive — the deeply-confirmed close is the whole story.
          void upsertCloseRecord({
            ...facts,
            txs: [],
            completedAt: Date.now(),
            resolution: 'verified',
          })
        } else if (
          closeFinal &&
          (current.closeType === 'coop' ||
            (current.claimableAtHeight !== undefined &&
              current.claimableAtHeight + FINALITY_CONFS <= tipHeight) ||
            // Timelock never captured (pre-feature channel): fall back to the
            // maximum possible to_self_delay so force closes still reach a
            // terminal state in bounded time instead of pending forever.
            (closeTx?.confirmedAtHeight !== undefined &&
              closeTx.confirmedAtHeight + MAX_TIMELOCK_BLOCKS + FINALITY_CONFS <= tipHeight))
        ) {
          // Close resolved on-chain but our wallet never saw the funds arrive
          // (e.g. swept on a device we can't see). Terminal, rendered
          // distinctly — never laundered into "complete".
          void upsertCloseRecord({
            ...facts,
            txs: [],
            completedAt: Date.now(),
            resolution: 'unverified',
          })
        }
      } catch (err: unknown) {
        captureError(
          'warning',
          'CloseRecords',
          `Reconcile: record ${record.channelId.slice(0, 8)}… skipped`,
          String(err)
        )
      }
      if (queryBudget <= 0) break
    }
  } catch (err: unknown) {
    // Pass-level failure (e.g. tip-height fetch): records stay stale and
    // heal on a later pass. Stale is safe; wrong "complete" is not.
    captureError('warning', 'CloseRecords', 'Reconcile pass aborted', String(err))
  } finally {
    reconcileInProgress = false
  }
}
