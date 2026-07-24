import {
  SpendableOutputDescriptor,
  SpendableOutputDescriptor_StaticOutput,
  Result_SpendableOutputDescriptorDecodeErrorZ_OK,
  Result_TransactionNoneZ_OK,
  Option_u32Z,
  type KeysManager,
} from 'lightningdevkit'
import { ScriptBuf, type Wallet } from '@bitcoindevkit/bdk-wallet-web'
import { idbGetAll, idbDeleteBatch, idbPut } from '../storage/idb'
import { deriveAddressAtIndex, peekAddressAtIndex } from '../onchain/address-utils'
import { bytesToHex, txidBytesToHex } from './utils'
import { broadcastWithRetry } from './traits/broadcaster'
import { captureError } from '../storage/error-log'
import { getFeeRate } from '../shared/fee-cache'
import { attemptSubsidizedSweep } from './subsidized-sweep'

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

export interface SweepContext {
  keysManager: KeysManager
  bdkWallet: Wallet
  /** Script pubkey bytes for the sweep destination address. */
  destinationScript: Uint8Array
  esploraUrl: string
  esploraFallbackUrl?: string
  /** Confirmed sats to leave untouched for anchor CPFP (0 when no channels are open). */
  reserveSats?: bigint
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
  /**
   * True when a fee-subsidized sweep would rescue the funds but the confirmed
   * on-chain balance can't cover the subsidy — adding funds unblocks it.
   */
  needsOnchainFunds: boolean
  /** Estimated additional confirmed sats needed; null when not in shortfall. */
  shortfallSats: bigint | null
}

/** Fired whenever a sweep attempt changes what's pending — UI re-reads on this. */
export const SWEEP_STATE_EVENT = 'zinqq:sweep-state-changed'

function notifySweepStateChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SWEEP_STATE_EVENT))
}

let sweepInProgress = false
let lastAttemptFailed = false
let onchainShortfallSats: bigint | null = null

/** Cheap synchronous check for callers gating a faster retry cadence. */
export function sweepNeedsOnchainFunds(): boolean {
  return onchainShortfallSats !== null
}

function isLegacyEntry(entry: Uint8Array[] | SpendableOutputsEntry): entry is Uint8Array[] {
  return Array.isArray(entry)
}

/**
 * True when a descriptor is a StaticOutput paying to a script the BDK wallet
 * already owns. Our SignerProvider hands LDK wallet-derived addresses via
 * get_destination_script, so force-close resolutions produce StaticOutput
 * descriptors whose funds are already on-chain in the wallet — and which
 * KeysManager categorically cannot sign (it only recognizes its own two
 * internal scripts and returns Err for anything else). One such descriptor in
 * the all-or-nothing batch makes every sweep fail with `ldk-sign`, freezing
 * the descriptors that DO need sweeping.
 *
 * Never throws. A failed ownership check reads as "not wallet-owned", which
 * keeps the descriptor in the batch — the safe direction (status quo).
 */
export function isWalletOwnedStaticOutput(
  descriptor: SpendableOutputDescriptor,
  bdkWallet: Wallet
): boolean {
  if (!(descriptor instanceof SpendableOutputDescriptor_StaticOutput)) return false
  try {
    const scriptBytes = descriptor.output.script_pubkey
    // is_mine CONSUMES the ScriptBuf (wasm-bindgen move semantics: the glue
    // calls __destroy_into_raw on it). Never free() it afterwards — that
    // throws "null pointer passed to rust", and a throw here would misread
    // as "not wallet-owned". The wrapper is finalizer-registered, so nothing
    // leaks.
    if (bdkWallet.is_mine(ScriptBuf.from_bytes(scriptBytes))) return true

    // After a cross-device recovery the destination index may not be revealed
    // yet, making is_mine false for a script the wallet can in fact spend.
    // Compare against a pure re-derivation first; reveal (a wallet mutation)
    // only on a confirmed match, so foreign outputs kept in a failing batch
    // don't mutate wallet state on every retry.
    const keysId = descriptor.channel_keys_id
    if (keysId && keysId.length === 32 && keysId.some((b) => b !== 0)) {
      const derived = deriveAddressAtIndex(bdkWallet, keysId)
      const matches =
        derived.length === scriptBytes.length && derived.every((b, i) => b === scriptBytes[i])
      // Ensure BDK tracks the address so the funds show in the balance.
      if (matches) peekAddressAtIndex(bdkWallet, keysId)
      return matches
    }
    return false
  } catch {
    return false
  }
}

/** `txid:vout` key for a descriptor's outpoint; null when unreadable. */
function descriptorOutpointKey(descriptor: SpendableOutputDescriptor): string | null {
  try {
    const outpoint = descriptor.spendable_outpoint()
    return `${txidBytesToHex(outpoint.get_txid())}:${outpoint.get_index()}`
  } catch {
    return null
  }
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
  // LDK replays SpendableOutputs events across restarts while a sweep keeps
  // failing, persisting the same output under multiple keys until a sweep
  // pass prunes them — dedup so the banner doesn't double-count.
  const seenDescriptorHex = new Set<string>()
  const seenOutpoints = new Set<string>()

  for (const [, entry] of entries) {
    const serialized = isLegacyEntry(entry) ? entry : entry.descriptors
    for (const bytes of serialized) {
      const hex = bytesToHex(bytes)
      if (seenDescriptorHex.has(hex)) continue
      seenDescriptorHex.add(hex)
      descriptorCount++
    }
    if (isLegacyEntry(entry)) {
      hasUnknownValue = true
      continue
    }
    if (entry.outpoints.length === 0) hasUnknownValue = true
    for (const outpoint of entry.outpoints) {
      const outpointKey = `${outpoint.txid}:${outpoint.vout}`
      if (seenOutpoints.has(outpointKey)) continue
      seenOutpoints.add(outpointKey)
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
    needsOnchainFunds: onchainShortfallSats !== null,
    shortfallSats: onchainShortfallSats,
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
 * When the self-funded spend fails (outputs can't pay their own fee), a
 * fee-subsidized sweep is attempted with confirmed on-chain UTXOs covering
 * the shortfall — see subsidized-sweep.ts.
 *
 * Guarded against concurrent execution — only one sweep can run at a time.
 *
 * @returns Summary of swept and skipped outputs
 */
export async function sweepSpendableOutputs(ctx: SweepContext): Promise<SweepResult> {
  const { keysManager, destinationScript, esploraUrl, esploraFallbackUrl } = ctx
  if (sweepInProgress) return { swept: 0, skipped: 0, txs: [] }
  sweepInProgress = true
  try {
    const entries = await idbGetAll<Uint8Array[] | SpendableOutputsEntry>('ldk_spendable_outputs')
    if (entries.size === 0) return { swept: 0, skipped: 0, txs: [] }

    const allDescriptors: SpendableOutputDescriptor[] = []
    /**
     * Serialized bytes for every entry in allDescriptors: the wasm bindings
     * consume descriptor objects per call, so the subsidized path re-decodes
     * from these instead of reusing the objects spent on the plain attempt.
     */
    const allSerialized: Uint8Array[] = []
    const seenDescriptorHex = new Set<string>()
    const idbKeys: string[] = []
    const attributions: SweepAttribution[] = []
    /** Entries left with nothing sweepable after pruning — deleted outright. */
    const emptiedKeys: string[] = []
    let skipped = 0
    let walletOwnedCount = 0

    for (const [key, entry] of entries) {
      const serializedArray = isLegacyEntry(entry) ? entry : entry.descriptors
      const descriptors: SpendableOutputDescriptor[] = []
      const serialized: Uint8Array[] = []
      const prunedOutpointKeys = new Set<string>()
      let prunedCount = 0
      let valid = true

      for (const bytes of serializedArray) {
        // A replayed event can persist the same descriptor under two keys;
        // duplicates would make both LDK spend paths fail outright.
        const hex = bytesToHex(bytes)
        if (seenDescriptorHex.has(hex)) {
          prunedCount++
          continue
        }

        const result = SpendableOutputDescriptor.constructor_read(bytes)
        if (!(result instanceof Result_SpendableOutputDescriptorDecodeErrorZ_OK)) {
          captureError(
            'error',
            'Sweep',
            `Failed to deserialize SpendableOutputDescriptor for key: ${key}`
          )
          valid = false
          break
        }

        seenDescriptorHex.add(hex)

        // Wallet-owned StaticOutputs need no sweep (the funds already pay to
        // an address BDK tracks) and would poison the batch — see
        // isWalletOwnedStaticOutput.
        if (isWalletOwnedStaticOutput(result.res, ctx.bdkWallet)) {
          const outpointKey = descriptorOutpointKey(result.res)
          if (outpointKey !== null) prunedOutpointKeys.add(outpointKey)
          prunedCount++
          walletOwnedCount++
          continue
        }

        descriptors.push(result.res)
        serialized.push(bytes)
      }

      if (!valid) {
        skipped += serializedArray.length
        continue
      }

      if (descriptors.length === 0) {
        // Everything in this entry was wallet-owned or a duplicate of another
        // entry — nothing to sweep, so remove it and stop counting it.
        emptiedKeys.push(key)
        continue
      }

      const outpoints = isLegacyEntry(entry)
        ? []
        : entry.outpoints.filter((o) => !prunedOutpointKeys.has(`${o.txid}:${o.vout}`))
      const channelIdHex = isLegacyEntry(entry) ? null : entry.channelIdHex

      if (prunedCount > 0) {
        // Persist the pruned entry so dropped descriptors never re-enter the
        // batch or the pending banner, even if this sweep attempt fails.
        // A failed write must not abort the pass: the in-memory prune already
        // protects this batch, and the next pass re-prunes from IDB.
        try {
          await idbPut('ldk_spendable_outputs', key, {
            descriptors: serialized,
            channelIdHex,
            outpoints,
          } satisfies SpendableOutputsEntry)
        } catch (err: unknown) {
          captureError('warning', 'Sweep', 'Failed to persist pruned entry', String(err))
        }
      }

      allDescriptors.push(...descriptors)
      allSerialized.push(...serialized)
      idbKeys.push(key)
      attributions.push({ channelIdHex, outpoints })
    }

    if (emptiedKeys.length > 0) {
      try {
        await idbDeleteBatch('ldk_spendable_outputs', emptiedKeys)
      } catch (err: unknown) {
        // Non-fatal: the entries hold nothing sweepable, so leaving them for
        // the next pass only overstates the banner until then.
        captureError('warning', 'Sweep', 'Failed to delete emptied sweep entries', String(err))
      }
    }
    if (walletOwnedCount > 0) {
      console.log(
        '[Sweep]',
        walletOwnedCount,
        'output(s) already pay to the on-chain wallet; excluded from sweep'
      )
    }

    if (allDescriptors.length === 0) {
      // Nothing sweepable remains. Undecodable entries are stuck funds and
      // keep the pending banner; entries emptied by pruning were funds the
      // wallet already holds, which is a healthy state.
      lastAttemptFailed = skipped > 0
      onchainShortfallSats = null
      notifySweepStateChanged()
      return { swept: 0, skipped, txs: [] }
    }

    // Fetch fee rate and convert from sat/vB to sat/kw (×250)
    let feeRateSatVb: number
    let feeRateSatPer1000Weight: number
    try {
      const rawRate = await getFeeRate(FEE_TARGET_BLOCKS)
      const ceiledRate = Math.ceil(rawRate)
      feeRateSatVb = Math.max(Math.min(ceiledRate, MAX_FEE_RATE_SAT_VB), MIN_FEE_RATE_SAT_VB)
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
      onchainShortfallSats = null
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
      // spend_spendable_outputs fails when the outputs can't pay their own
      // fee (or are timelocked) — try covering the shortfall with confirmed
      // on-chain funds before giving up.
      captureError(
        'warning',
        'Sweep',
        `spend_spendable_outputs failed — attempting subsidized sweep, descriptors: ${allDescriptors.length}`
      )
      const outcome = await attemptSubsidizedSweep({
        keysManager,
        bdkWallet: ctx.bdkWallet,
        serializedDescriptors: allSerialized,
        destinationScript,
        targetFeeRateSatVb: BigInt(feeRateSatVb),
        esploraUrl,
        esploraFallbackUrl,
        reserveSats: ctx.reserveSats ?? 0n,
      })

      if (outcome.status === 'broadcast') {
        await idbDeleteBatch('ldk_spendable_outputs', idbKeys)
        lastAttemptFailed = skipped > 0
        onchainShortfallSats = null
        notifySweepStateChanged()
        console.log(
          '[Sweep] Subsidized sweep rescued',
          allDescriptors.length,
          'output(s), txid:',
          outcome.txid
        )
        return {
          swept: allDescriptors.length,
          skipped,
          txs: [{ txid: outcome.txid, attributions }],
        }
      }

      lastAttemptFailed = true
      onchainShortfallSats = outcome.status === 'shortfall' ? outcome.shortfallSats : null
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
      onchainShortfallSats = null
      notifySweepStateChanged()
      return { swept: 0, skipped: skipped + allDescriptors.length, txs: [] }
    }

    // Clean up IDB entries atomically after successful broadcast. Entries
    // skipped this pass (e.g. undecodable) are still stuck — keep the
    // pending state flagged so the banner doesn't hide them.
    await idbDeleteBatch('ldk_spendable_outputs', idbKeys)
    lastAttemptFailed = skipped > 0
    onchainShortfallSats = null
    notifySweepStateChanged()

    console.log('[Sweep] Successfully swept', allDescriptors.length, 'output(s), txid:', txid)

    return { swept: allDescriptors.length, skipped, txs: [{ txid, attributions }] }
  } finally {
    sweepInProgress = false
  }
}
