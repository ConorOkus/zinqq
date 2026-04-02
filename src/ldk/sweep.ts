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
import { ACTIVE_NETWORK } from './config'
import { captureError } from '../storage/error-log'

const FEE_TARGET_BLOCKS = 6
const DEFAULT_FEE_RATE_SAT_VB = ACTIVE_NETWORK === 'mainnet' ? 4 : 1
const MIN_FEE_RATE_SAT_VB = ACTIVE_NETWORK === 'mainnet' ? 2 : 1
const MAX_FEE_RATE_SAT_VB = 500

/**
 * Fetch the fee rate (sat/vB) from Esplora's fee-estimates endpoint.
 * Falls back to 1 sat/vB on failure.
 */
async function fetchFeeRate(esploraUrl: string): Promise<number> {
  try {
    const res = await fetch(`${esploraUrl}/fee-estimates`)
    const estimates = (await res.json()) as Record<string, number>
    const satPerVb = estimates[String(FEE_TARGET_BLOCKS)]
    if (typeof satPerVb === 'number' && satPerVb > 0) {
      const capped = Math.max(
        Math.min(Math.ceil(satPerVb), MAX_FEE_RATE_SAT_VB),
        MIN_FEE_RATE_SAT_VB
      )
      if (capped < Math.ceil(satPerVb)) {
        captureError(
          'warning',
          'Sweep',
          `Fee rate capped from ${Math.ceil(satPerVb)} to ${MAX_FEE_RATE_SAT_VB} sat/vB`
        )
      }
      return capped
    }
  } catch (err: unknown) {
    captureError('warning', 'Sweep', 'Fee estimation failed, using default', String(err))
  }
  return DEFAULT_FEE_RATE_SAT_VB
}

export interface SweepResult {
  swept: number
  skipped: number
  txid: string | null
}

let sweepInProgress = false

/**
 * Sweep all persisted SpendableOutputDescriptors from IDB back to an on-chain
 * address. Uses KeysManager.as_OutputSpender().spend_spendable_outputs() to
 * handle all descriptor types, key derivation, and signing internally.
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
  if (sweepInProgress) return { swept: 0, skipped: 0, txid: null }
  sweepInProgress = true
  try {
    const entries = await idbGetAll<Uint8Array[]>('ldk_spendable_outputs')
    if (entries.size === 0) return { swept: 0, skipped: 0, txid: null }

    const allDescriptors: SpendableOutputDescriptor[] = []
    const idbKeys: string[] = []
    let skipped = 0

    for (const [key, serializedArray] of entries) {
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
      } else {
        skipped += serializedArray.length
      }
    }

    if (allDescriptors.length === 0) {
      return { swept: 0, skipped, txid: null }
    }

    // Fetch fee rate and convert from sat/vB to sat/kw (×250)
    const feeRateSatVb = await fetchFeeRate(esploraUrl)
    const feeRateSatPer1000Weight = feeRateSatVb * 250

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
      return { swept: 0, skipped: skipped + allDescriptors.length, txid: null }
    }

    const txHex = bytesToHex(result.res)
    const txid = await broadcastWithRetry(esploraUrl, txHex, esploraFallbackUrl)

    // Clean up IDB entries atomically after successful broadcast
    await idbDeleteBatch('ldk_spendable_outputs', idbKeys)

    console.log('[Sweep] Successfully swept', allDescriptors.length, 'output(s), txid:', txid)

    return { swept: allDescriptors.length, skipped, txid }
  } finally {
    sweepInProgress = false
  }
}
