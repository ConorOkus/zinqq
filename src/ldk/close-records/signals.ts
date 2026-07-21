/**
 * Bridge between LDK events and close records. The event handler drains LDK
 * WASM objects into these primitives-only signals synchronously (no WASM
 * handle survives into an async path), then hands them to `handleCloseSignal`
 * via the injected callback — record logic never lives in the event handler.
 */

import { captureError } from '../../storage/error-log'
import { CLOSE_RECORD_SCHEMA_VERSION, type CloseRecord, type Outpoint } from './close-record'
import { getCloseRecordSync, getFundingTxoMap, removeFundingTxo, upsertCloseRecord } from './store'
import type { SweepResult } from '../sweep'

export type CloseSignal =
  | {
      type: 'channel_closed'
      channelIdHex: string
      description: string
      closeType: 'coop' | 'force' | 'unknown'
      initiator: 'local' | 'remote' | 'unknown'
      hasOnchainTx: boolean
      fundingTxo: Outpoint | null
      /** From last_local_balance_msat only — NEVER the channel-capacity fallback (it overstates by the whole capacity). */
      lastLocalBalanceSats: bigint | null
    }
  | {
      type: 'commitment_broadcast'
      channelIdHex: string
      txid: string
      feeSats: bigint
    }

export type CloseLifecycleCallback = (signal: CloseSignal) => void

/** Fire-and-forget from the sync event handler; all writes serialize in the store. */
export function handleCloseSignal(signal: CloseSignal): void {
  try {
    if (signal.type === 'channel_closed') {
      const fundingTxo =
        signal.fundingTxo ?? getFundingTxoMap().get(signal.channelIdHex) ?? undefined

      // No on-chain close tx and nothing to watch → no record. Also drop the
      // funding-txo safety-net entry so reconciliation doesn't resurrect it.
      if (!signal.hasOnchainTx && !getCloseRecordSync(signal.channelIdHex)) {
        void removeFundingTxo(signal.channelIdHex)
        return
      }

      const record: CloseRecord = {
        schemaVersion: CLOSE_RECORD_SCHEMA_VERSION,
        channelId: signal.channelIdHex,
        ...(fundingTxo ? { fundingTxo } : {}),
        closeType: signal.closeType,
        initiator: signal.initiator,
        closureReason: signal.description,
        txs: [],
        ...(signal.lastLocalBalanceSats !== null
          ? { expectedAmountSats: signal.lastLocalBalanceSats }
          : {}),
        createdAt: Date.now(),
      }
      void upsertCloseRecord(record)
      // The record now carries the funding txo; the safety-net map entry is
      // only needed for closes that never produced a record.
      void removeFundingTxo(signal.channelIdHex)
      return
    }

    // commitment_broadcast: the anchor CPFP path handed us the actual
    // commitment tx — attach txid + pre-committed fee.
    const record: CloseRecord = {
      schemaVersion: CLOSE_RECORD_SCHEMA_VERSION,
      channelId: signal.channelIdHex,
      closeType: 'force',
      initiator: 'unknown',
      txs: [{ txid: signal.txid, role: 'commitment', feeSats: signal.feeSats }],
      createdAt: Date.now(),
    }
    void upsertCloseRecord(record)
  } catch (err: unknown) {
    captureError('error', 'CloseRecords', 'handleCloseSignal failed', String(err))
  }
}

/**
 * Attach a broadcast sweep txid to every record whose channel contributed an
 * output. Attribution is by the channelId captured with each persisted
 * descriptor entry — never by "the sweep my event triggered" (batching and
 * the sweep-in-progress guard make causality nondeterministic). Entries
 * persisted before this feature carry no channelId and stay unattributed.
 */
export function recordSweepResult(result: SweepResult): void {
  const txid = result.txid
  // broadcastWithRetry can return sentinel strings instead of a txid.
  if (!txid || txid === 'in-flight' || txid === 'already-broadcast') return
  const channelIds = new Set(
    result.attributions.map((a) => a.channelIdHex).filter((id): id is string => id !== null)
  )
  for (const channelIdHex of channelIds) {
    const record: CloseRecord = {
      schemaVersion: CLOSE_RECORD_SCHEMA_VERSION,
      channelId: channelIdHex,
      closeType: 'unknown',
      initiator: 'unknown',
      txs: [{ txid, role: 'sweep' }],
      createdAt: Date.now(),
    }
    void upsertCloseRecord(record)
  }
}
