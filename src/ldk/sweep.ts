import {
  SpendableOutputDescriptor,
  Result_SpendableOutputDescriptorDecodeErrorZ_OK,
  Result_TransactionNoneZ_OK,
  Option_u32Z,
  type KeysManager,
} from 'lightningdevkit'
import { idbGetAll, idbDeleteBatch } from '../storage/idb'
import { bytesToHex } from './utils'
import { broadcastWithRetry } from './traits/broadcaster'
import { captureError } from '../storage/error-log'
import { getFeeRate } from '../shared/fee-cache'

const FEE_TARGET_BLOCKS = 6
const MIN_FEE_RATE_SAT_VB = 2
const MAX_FEE_RATE_SAT_VB = 500

/**
 * Persisted shape of an `ldk_spendable_outputs` entry. Entries written
 * before close-record attribution existed are bare `Uint8Array[]`
 * (descriptors only) — both shapes must stay sweepable.
 */
export interface SpendableOutputsEntry {
  descriptors: Uint8Array[]
  channelIdHex: string | null
  outpoints: { txid: string; vout: number; valueSats: string }[]
}

export interface SweepAttribution {
  channelIdHex: string | null
  outpoints: { txid: string; vout: number; valueSats: string }[]
}

/** One broadcast sweep transaction and the IDB entries it consumed. */
export interface SweptTx {
  txid: string
  attributions: SweepAttribution[]
}

export interface SweepResult {
  swept: number
  skipped: number
  /** One entry per broadcast transaction — the basis for close-record sweep attribution. */
  txs: SweptTx[]
}

/** Snapshot of outputs still waiting to sweep, for user-facing surfaces. */
export interface PendingSweepInfo {
  entryCount: number
  descriptorCount: number
  /** Total known value across pending outputs (sats). Legacy entries contribute 0. */
  pendingSats: bigint
  /**
   * True when at least one entry predates outpoint tracking or carries
   * unreadable value data, so pendingSats undercounts the real total.
   */
  hasUnknownValue: boolean
  /** True when the most recent sweep attempt failed (dust, timelock, fees, broadcast). */
  lastAttemptFailed: boolean
}

/** Fired whenever a sweep attempt changes what's pending — UI re-reads on this. */
export const SWEEP_STATE_EVENT = 'zinqq:sweep-state-changed'

function notifySweepStateChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SWEEP_STATE_EVENT))
}

let sweepInProgress = false
let lastAttemptFailed = false

function isLegacyEntry(entry: Uint8Array[] | SpendableOutputsEntry): entry is Uint8Array[] {
  return Array.isArray(entry)
}

/**
 * Read what's still waiting to sweep. Returns null when nothing is pending.
 */
export async function getPendingSweepInfo(): Promise<PendingSweepInfo | null> {
  const entries = await idbGetAll<Uint8Array[] | SpendableOutputsEntry>('ldk_spendable_outputs')
  if (entries.size === 0) return null

  let descriptorCount = 0
  let pendingSats = 0n
  let hasUnknownValue = false

  for (const [, entry] of entries) {
    if (isLegacyEntry(entry)) {
      descriptorCount += entry.length
      hasUnknownValue = true
      continue
    }
    descriptorCount += entry.descriptors.length
    if (entry.outpoints.length === 0) hasUnknownValue = true
    for (const outpoint of entry.outpoints) {
      try {
        pendingSats += BigInt(outpoint.valueSats)
      } catch {
        // Unreadable value data must never gate the sweep or the banner.
        hasUnknownValue = true
      }
    }
  }

  return {
    entryCount: entries.size,
    descriptorCount,
    pendingSats,
    hasUnknownValue,
    lastAttemptFailed,
  }
}

/**
 * Sweep all persisted SpendableOutputDescriptors from IDB back to an on-chain
 * address. Uses KeysManager.as_OutputSpender().spend_spendable_outputs() to
 * handle all descriptor types, key derivation, and signing internally.
 *
 * All descriptors are swept together in a single transaction (one broadcast,
 * shared fee) — either everything sweeps or nothing does. A failed attempt
 * (outputs dust or timelocked at the current fee rate) leaves the entries in
 * IDB and flags the pending state so the UI can explain; callers retry
 * periodically and the sweep completes once it becomes economical.
 *
 * Guarded against concurrent execution — only one sweep can run at a time.
 *
 * @param keysManager - LDK KeysManager for signing
 * @param destinationScript - Script pubkey bytes for the sweep destination address
 * @param esploraUrl - Esplora API URL for fee estimation and broadcast
 * @returns Summary of swept and skipped outputs
 */
export async function sweepSpendableOutputs(
  keysManager: KeysManager,
  destinationScript: Uint8Array,
  esploraUrl: string,
  esploraFallbackUrl?: string
): Promise<SweepResult> {
  if (sweepInProgress) return { swept: 0, skipped: 0, txs: [] }
  sweepInProgress = true
  try {
    const entries = await idbGetAll<Uint8Array[] | SpendableOutputsEntry>('ldk_spendable_outputs')
    if (entries.size === 0) return { swept: 0, skipped: 0, txs: [] }

    const allDescriptors: SpendableOutputDescriptor[] = []
    const idbKeys: string[] = []
    const attributions: SweepAttribution[] = []
    let skipped = 0

    for (const [key, entry] of entries) {
      const serializedArray = isLegacyEntry(entry) ? entry : entry.descriptors
      const descriptors: SpendableOutputDescriptor[] = []
      let valid = true

      for (const bytes of serializedArray) {
        const result = SpendableOutputDescriptor.constructor_read(bytes)
        if (result instanceof Result_SpendableOutputDescriptorDecodeErrorZ_OK) {
          descriptors.push(result.res)
        } else {
          captureError(
            'error',
            'Sweep',
            `Failed to deserialize SpendableOutputDescriptor for key: ${key}`
          )
          valid = false
          break
        }
      }

      if (valid && descriptors.length > 0) {
        allDescriptors.push(...descriptors)
        idbKeys.push(key)
        attributions.push(
          isLegacyEntry(entry)
            ? { channelIdHex: null, outpoints: [] }
            : { channelIdHex: entry.channelIdHex, outpoints: entry.outpoints }
        )
      } else {
        skipped += serializedArray.length
      }
    }

    if (allDescriptors.length === 0) {
      // Entries exist but none decoded — funds are stuck; surface it like the
      // other failure paths so the pending banner appears.
      lastAttemptFailed = true
      notifySweepStateChanged()
      return { swept: 0, skipped, txs: [] }
    }

    // Fetch fee rate and convert from sat/vB to sat/kw (×250)
    let feeRateSatPer1000Weight: number
    try {
      const rawRate = await getFeeRate(FEE_TARGET_BLOCKS)
      const ceiledRate = Math.ceil(rawRate)
      const feeRateSatVb = Math.max(Math.min(ceiledRate, MAX_FEE_RATE_SAT_VB), MIN_FEE_RATE_SAT_VB)
      if (feeRateSatVb < ceiledRate) {
        captureError(
          'warning',
          'Sweep',
          `Fee rate capped from ${ceiledRate} to ${MAX_FEE_RATE_SAT_VB} sat/vB`
        )
      }
      feeRateSatPer1000Weight = feeRateSatVb * 250
    } catch (err: unknown) {
      captureError('error', 'Sweep', 'Fee rate estimation failed', String(err))
      lastAttemptFailed = true
      notifySweepStateChanged()
      return { swept: 0, skipped: skipped + allDescriptors.length, txs: [] }
    }

    // Build + sign sweep tx via LDK's OutputSpender
    const outputSpender = keysManager.as_OutputSpender()
    const result = outputSpender.spend_spendable_outputs(
      allDescriptors,
      [], // no additional TxOut
      destinationScript,
      feeRateSatPer1000Weight,
      Option_u32Z.constructor_none() // no locktime preference
    )

    if (!(result instanceof Result_TransactionNoneZ_OK)) {
      // spend_spendable_outputs can fail if outputs are dust or uneconomical
      captureError(
        'warning',
        'Sweep',
        `spend_spendable_outputs failed — outputs may be dust or timelocked, descriptors: ${allDescriptors.length}`
      )
      lastAttemptFailed = true
      notifySweepStateChanged()
      return { swept: 0, skipped: skipped + allDescriptors.length, txs: [] }
    }

    let txid: string
    try {
      const txHex = bytesToHex(result.res)
      txid = await broadcastWithRetry(esploraUrl, txHex, esploraFallbackUrl)
    } catch (err: unknown) {
      captureError('error', 'Sweep', 'Broadcast failed after signing', String(err))
      lastAttemptFailed = true
      notifySweepStateChanged()
      return { swept: 0, skipped: skipped + allDescriptors.length, txs: [] }
    }

    // Clean up IDB entries atomically after successful broadcast. Entries
    // skipped this pass (e.g. undecodable) are still stuck — keep the
    // pending state flagged so the banner doesn't hide them.
    await idbDeleteBatch('ldk_spendable_outputs', idbKeys)
    lastAttemptFailed = skipped > 0
    notifySweepStateChanged()

    console.log('[Sweep] Successfully swept', allDescriptors.length, 'output(s), txid:', txid)

    return { swept: allDescriptors.length, skipped, txs: [{ txid, attributions }] }
  } finally {
    sweepInProgress = false
  }
}
