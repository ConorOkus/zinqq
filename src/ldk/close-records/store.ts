/**
 * Close-records store: one owner, serialized writes.
 *
 * - In-memory `Map` is the synchronous read model (the BumpTransaction event
 *   handler must never await IDB to look up close context — todo #203's
 *   lesson is "one owner, serialized writes", not "no maps").
 * - Every mutation goes through a single promise chain: read → pure merge →
 *   write. No interleaved read-modify-write.
 * - IDB-first, VSS best-effort — a deliberate deviation from the channel
 *   monitor pattern's VSS-first ordering: monitors gate `channel_monitor_updated`;
 *   close records have no such gate (the event handler already returned ok()),
 *   and VSS-first would leave the UI without the record during a VSS outage.
 *   The reconciliation pass is the designated healer for lost VSS writes.
 * - VSS 409 conflicts fetch the remote map and MERGE field-wise before
 *   rewriting — the stock blob-LWW helper would clobber the other device's
 *   facts (its sweep txid vs our commitment fee).
 * - Singleton VSS key: per-record keys can never be enumerated on restore
 *   (keys are HMAC-obfuscated), so the whole map lives under one key.
 */

import { idbGet, idbPut } from '../../storage/idb'
import { isVssConflict, type VssClient } from '../storage/vss-client'
import { captureError } from '../../storage/error-log'
import {
  type CloseRecord,
  type Outpoint,
  mergeCloseRecords,
  serializeCloseRecord,
  deserializeCloseRecord,
} from './close-record'

const IDB_STORE = 'ldk_close_records'
const RECORDS_KEY = 'records'
const FUNDING_TXOS_KEY = 'funding_txos'
const VSS_KEY = 'close_records'

/** Payload-less by design: listeners re-read the snapshot (a stale payload resolving late would show yesterday's state). */
export const CLOSE_RECORDS_CHANGED_EVENT = 'zinqq:close-records-changed'

let records = new Map<string, CloseRecord>()
let snapshot: readonly CloseRecord[] = []
let fundingTxos = new Map<string, Outpoint>()
let vssClientRef: VssClient | null = null
const vssVersionRef = { current: 0 }
let writeChain: Promise<void> = Promise.resolve()
let initialized = false

function refreshSnapshot(): void {
  snapshot = Object.freeze(Array.from(records.values()).sort((a, b) => b.createdAt - a.createdAt))
}

function notifyChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CLOSE_RECORDS_CHANGED_EVENT))
  }
}

function encodeRecordsMap(map: Map<string, CloseRecord>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [channelId, record] of map) out[channelId] = serializeCloseRecord(record)
  return out
}

function decodeRecordsMap(raw: unknown): Map<string, CloseRecord> {
  const map = new Map<string, CloseRecord>()
  if (typeof raw !== 'object' || raw === null) return map
  for (const value of Object.values(raw as Record<string, unknown>)) {
    const record = deserializeCloseRecord(value)
    if (record) map.set(record.channelId, record)
  }
  return map
}

function mergeMapInto(target: Map<string, CloseRecord>, source: Map<string, CloseRecord>): void {
  for (const [channelId, incoming] of source) {
    const existing = target.get(channelId)
    target.set(channelId, existing ? mergeCloseRecords(existing, incoming) : incoming)
  }
}

async function persistLocked(): Promise<void> {
  const encoded = encodeRecordsMap(records)
  await idbPut(IDB_STORE, RECORDS_KEY, encoded)
  refreshSnapshot()
  notifyChanged()

  const vssClient = vssClientRef
  if (!vssClient) return
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(encoded))
    try {
      vssVersionRef.current = await vssClient.putObject(VSS_KEY, bytes, vssVersionRef.current)
    } catch (err: unknown) {
      if (!isVssConflict(err)) throw err
      // Another device wrote first: fetch, field-wise merge, rewrite.
      const remote = await vssClient.getObject(VSS_KEY)
      vssVersionRef.current = remote ? remote.version : 0
      if (remote) {
        const remoteMap = decodeRecordsMap(
          JSON.parse(new TextDecoder().decode(remote.value)) as unknown
        )
        mergeMapInto(records, remoteMap)
        refreshSnapshot()
        notifyChanged()
      }
      const mergedBytes = new TextEncoder().encode(JSON.stringify(encodeRecordsMap(records)))
      vssVersionRef.current = await vssClient.putObject(VSS_KEY, mergedBytes, vssVersionRef.current)
      await idbPut(IDB_STORE, RECORDS_KEY, encodeRecordsMap(records))
    }
  } catch (err: unknown) {
    // IDB has the record; reconciliation + the next write heal VSS later.
    captureError('warning', 'CloseRecords', 'VSS write failed (IDB saved)', String(err))
  }
}

function enqueue(mutation: () => Promise<void>): Promise<void> {
  const next = writeChain.then(mutation).catch((err: unknown) => {
    captureError('error', 'CloseRecords', 'Store mutation failed', String(err))
  })
  writeChain = next
  return next
}

/**
 * Load records from IDB (fast), then merge VSS state in (durable,
 * cross-device) and seed the VSS version. Must run before the event
 * processor starts so the sync read model is populated for event replays.
 */
export async function initCloseRecords(vssClient: VssClient | null): Promise<void> {
  vssClientRef = vssClient
  await enqueue(async () => {
    try {
      const rawLocal = await idbGet<Record<string, unknown>>(IDB_STORE, RECORDS_KEY)
      records = decodeRecordsMap(rawLocal)
      const rawTxos = await idbGet<Record<string, Outpoint>>(IDB_STORE, FUNDING_TXOS_KEY)
      fundingTxos = new Map(Object.entries(rawTxos ?? {}))
    } catch (err: unknown) {
      captureError('error', 'CloseRecords', 'IDB load failed', String(err))
    }

    if (vssClient) {
      try {
        const remote = await vssClient.getObject(VSS_KEY)
        if (remote) {
          vssVersionRef.current = remote.version
          const remoteMap = decodeRecordsMap(
            JSON.parse(new TextDecoder().decode(remote.value)) as unknown
          )
          const before = JSON.stringify(encodeRecordsMap(records))
          mergeMapInto(records, remoteMap)
          if (JSON.stringify(encodeRecordsMap(records)) !== before) {
            await idbPut(IDB_STORE, RECORDS_KEY, encodeRecordsMap(records))
          }
        }
      } catch (err: unknown) {
        captureError('warning', 'CloseRecords', 'VSS seed failed', String(err))
      }
    }

    refreshSnapshot()
    initialized = true
    notifyChanged()
  })
}

/** Immutable snapshot, newest first. Reference is stable between mutations. */
export function getCloseRecordsSnapshot(): readonly CloseRecord[] {
  return snapshot
}

/** Synchronous read model — safe to call from LDK's sync event handler. */
export function getCloseRecordSync(channelId: string): CloseRecord | undefined {
  return records.get(channelId)
}

export function closeRecordsInitialized(): boolean {
  return initialized
}

/**
 * Create-or-merge. The in-memory map (the sync read model) is updated
 * SYNCHRONOUSLY — `Event_BumpTransaction` fires microseconds after
 * `Event_ChannelClosed` in the same drain pass and must see the record.
 * Persistence is enqueued behind the serialized write chain.
 */
export function upsertCloseRecord(incoming: CloseRecord): Promise<void> {
  const existing = records.get(incoming.channelId)
  records.set(incoming.channelId, existing ? mergeCloseRecords(existing, incoming) : incoming)
  refreshSnapshot()
  return enqueue(() => persistLocked())
}

/** Persist the channelId → funding outpoint safety net while channels are open. */
export function recordFundingTxo(channelId: string, outpoint: Outpoint): Promise<void> {
  return enqueue(async () => {
    const existing = fundingTxos.get(channelId)
    if (existing && existing.txid === outpoint.txid && existing.vout === outpoint.vout) return
    fundingTxos.set(channelId, outpoint)
    await idbPut(IDB_STORE, FUNDING_TXOS_KEY, Object.fromEntries(fundingTxos))
  })
}

export function getFundingTxoMap(): ReadonlyMap<string, Outpoint> {
  return fundingTxos
}

export function removeFundingTxo(channelId: string): Promise<void> {
  return enqueue(async () => {
    if (!fundingTxos.delete(channelId)) return
    await idbPut(IDB_STORE, FUNDING_TXOS_KEY, Object.fromEntries(fundingTxos))
  })
}

// Ephemeral last-seen tip height (set by reconciliation) — lets the UI derive
// live confirmation counts and timelock countdowns without extra requests.
let lastKnownTipHeight: number | null = null

export function setLastKnownTipHeight(height: number): void {
  lastKnownTipHeight = height
  notifyChanged()
}

export function getLastKnownTipHeight(): number | null {
  return lastKnownTipHeight
}

/** Test-only: reset module state between tests. */
export function resetCloseRecordsForTest(): void {
  records = new Map()
  fundingTxos = new Map()
  snapshot = []
  vssClientRef = null
  vssVersionRef.current = 0
  writeChain = Promise.resolve()
  initialized = false
  lastKnownTipHeight = null
}
