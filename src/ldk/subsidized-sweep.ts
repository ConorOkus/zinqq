import {
  SpendableOutputDescriptor,
  Result_SpendableOutputDescriptorDecodeErrorZ_OK,
  Result_C2Tuple_CVec_u8Zu64ZNoneZ_OK,
  Result_CVec_u8ZNoneZ_OK,
  UtilMethods,
  Option_u32Z,
  type KeysManager,
} from 'lightningdevkit'
import { Psbt, SignOptions, type Wallet } from '@bitcoindevkit/bdk-wallet-web'
import { revealNextAddress } from '../onchain/address-utils'
import { broadcastWithRetry } from './traits/broadcaster'
import { captureError } from '../storage/error-log'
import { bytesToHex, uint8ArrayToBase64 } from './utils'
import {
  parsePsbt,
  serializePsbt,
  appendForeignInputsAndChange,
  readWitnessUtxoValues,
  type ForeignInput,
  type ParsedPsbt,
} from './psbt-surgery'

/**
 * Fee-subsidized sweep: rescue LDK force-close outputs that can't pay their
 * own sweep fee by building one combined transaction where confirmed BDK
 * UTXOs cover the shortfall.
 *
 * The LDK side is created at the 1 sat/vB floor so nearly all swept value
 * survives as the destination output; BDK inputs (plus a change output) bring
 * the whole transaction up to the target feerate. LDK signs its inputs via
 * sign_spendable_outputs_psbt, BDK signs its own, and the result broadcasts
 * as a single package — no CPFP, so it works even when the mempool minimum
 * feerate is elevated.
 */

export const FLOOR_FEERATE_SAT_PER_KW = 250
export const DUST_LIMIT_SATS = 546n
/** P2WPKH input: 41 vbytes base (164 wu) + ~108 wu witness. */
export const BDK_INPUT_WEIGHT_WU = 272n
/** P2WPKH TxOut: 31 bytes. */
export const CHANGE_OUTPUT_WEIGHT_WU = 124n
export const MAX_SUBSIDY_INPUTS = 20
const ESPLORA_FETCH_TIMEOUT_MS = 10_000

export type SubsidizedSweepOutcome =
  | { status: 'broadcast'; txid: string; subsidySats: bigint }
  | { status: 'shortfall'; neededSubsidySats: bigint; availableSats: bigint; shortfallSats: bigint }
  | { status: 'not-economical'; neededSubsidySats: bigint; pendingSats: bigint }
  | { status: 'failed'; reason: string }

export interface SubsidizedSweepParams {
  keysManager: KeysManager
  bdkWallet: Wallet
  /**
   * Serialized descriptor bytes, not decoded objects: the wasm bindings pass
   * descriptor pointers by value with no clone, so each LDK call consumes the
   * objects it receives. Fresh decodes happen per call.
   */
  serializedDescriptors: Uint8Array[]
  destinationScript: Uint8Array
  targetFeeRateSatVb: bigint
  esploraUrl: string
  esploraFallbackUrl?: string
  /** Confirmed sats to leave untouched (anchor-CPFP reserve while channels are open). */
  reserveSats: bigint
}

export interface SelectionResult {
  selected: ForeignInput[]
  /** null → changeless variant (remainder absorbed into fee, bounded by dust + change-output fee). */
  changeSats: bigint | null
  totalFeeSats: bigint
  /** What the wallet actually contributes to the fee: Σ selected − change. */
  subsidySats: bigint
}

export type SelectionOutcome =
  | SelectionResult
  | { shortfall: { neededSubsidySats: bigint; availableSats: bigint } }

function feeForWeight(weightWu: bigint, rateSatVb: bigint): bigint {
  const vbytes = (weightWu + 3n) / 4n
  return vbytes * rateSatVb
}

function maxBigint(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}

/**
 * Largest-first selection of fee-subsidy inputs.
 *
 * The reserve constrains the final subsidy, not individual UTXOs — change
 * returns to the wallet, so what leaves the balance is exactly `subsidySats`.
 */
export function selectSubsidyInputs(
  candidates: ForeignInput[],
  ldkWeightWu: bigint,
  ldkFeeSats: bigint,
  targetRateSatVb: bigint,
  reserveSats: bigint
): SelectionOutcome {
  const totalAvailable = candidates.reduce((sum, c) => sum + c.valueSats, 0n)
  const spendable = maxBigint(totalAvailable - reserveSats, 0n)

  const neededWithChange = (n: bigint) =>
    maxBigint(
      feeForWeight(
        ldkWeightWu + n * BDK_INPUT_WEIGHT_WU + CHANGE_OUTPUT_WEIGHT_WU,
        targetRateSatVb
      ) - ldkFeeSats,
      0n
    )
  const neededChangeless = (n: bigint) =>
    maxBigint(feeForWeight(ldkWeightWu + n * BDK_INPUT_WEIGHT_WU, targetRateSatVb) - ldkFeeSats, 0n)

  const selected: ForeignInput[] = []
  let selectedSum = 0n

  for (const utxo of candidates) {
    if (selected.length >= MAX_SUBSIDY_INPUTS) break
    selected.push(utxo)
    selectedSum += utxo.valueSats
    const n = BigInt(selected.length)

    const needed = neededWithChange(n)
    if (needed > spendable) break // adding inputs only raises the fee — no solution

    const change = selectedSum - needed
    if (change >= DUST_LIMIT_SATS) {
      return {
        selected,
        changeSats: change,
        totalFeeSats: ldkFeeSats + needed,
        subsidySats: needed,
      }
    }

    const neededDrained = neededChangeless(n)
    if (selectedSum >= neededDrained && selectedSum <= spendable) {
      return {
        selected,
        changeSats: null,
        totalFeeSats: ldkFeeSats + selectedSum,
        subsidySats: selectedSum,
      }
    }
  }

  const n = BigInt(Math.max(selected.length, 1))
  return { shortfall: { neededSubsidySats: neededWithChange(n), availableSats: spendable } }
}

/** Confirmed P2WPKH UTXOs, sorted largest-first. */
export function listConfirmedP2wpkhUtxos(bdkWallet: Wallet): ForeignInput[] {
  const candidates: ForeignInput[] = []
  for (const output of bdkWallet.list_unspent()) {
    // Unconfirmed parents could drop from the mempool and invalidate the
    // sweep; only confirmed inputs are safe to build on.
    const wtx = bdkWallet.get_tx(output.outpoint.txid)
    if (!wtx?.chain_position.is_confirmed) continue

    const script = output.txout.script_pubkey.as_bytes()
    if (script.length !== 22 || script[0] !== 0x00 || script[1] !== 0x14) continue

    candidates.push({
      txidDisplayHex: output.outpoint.txid.toString(),
      vout: output.outpoint.vout,
      valueSats: output.txout.value.to_sat(),
      scriptPubkey: script,
    })
  }
  candidates.sort((a, b) => (b.valueSats > a.valueSats ? 1 : b.valueSats < a.valueSats ? -1 : 0))
  return candidates
}

function decodeDescriptors(serialized: Uint8Array[]): SpendableOutputDescriptor[] | null {
  const descriptors: SpendableOutputDescriptor[] = []
  for (const bytes of serialized) {
    const result = SpendableOutputDescriptor.constructor_read(bytes)
    if (!(result instanceof Result_SpendableOutputDescriptorDecodeErrorZ_OK)) return null
    descriptors.push(result.res)
  }
  return descriptors
}

async function isTxKnownToEsplora(
  txid: string,
  esploraUrl: string,
  esploraFallbackUrl?: string
): Promise<boolean> {
  for (const url of [esploraUrl, esploraFallbackUrl]) {
    if (!url) continue
    try {
      const res = await fetch(`${url}/tx/${txid}`, {
        signal: AbortSignal.timeout(ESPLORA_FETCH_TIMEOUT_MS),
      })
      if (res.ok) return true
    } catch {
      // Try the next URL; an unreachable esplora must read as "unknown".
    }
  }
  return false
}

interface LdkPsbtAnalysis {
  parsed: ParsedPsbt
  ldkWeightWu: bigint
  ldkInputSum: bigint
  ldkFeeSats: bigint
}

function failed(reason: string, detail?: string): SubsidizedSweepOutcome {
  captureError('warning', 'Sweep', `Subsidized sweep failed: ${reason}`, detail)
  return { status: 'failed', reason }
}

export async function attemptSubsidizedSweep(
  params: SubsidizedSweepParams
): Promise<SubsidizedSweepOutcome> {
  try {
    return await run(params)
  } catch (err: unknown) {
    return failed('unexpected-error', String(err))
  }
}

function createLdkPsbtAtFloor(
  params: SubsidizedSweepParams
): LdkPsbtAnalysis | SubsidizedSweepOutcome {
  const descriptors = decodeDescriptors(params.serializedDescriptors)
  if (!descriptors) return failed('descriptor-decode')

  const created = UtilMethods.constructor_SpendableOutputDescriptor_create_spendable_outputs_psbt(
    descriptors,
    [],
    params.destinationScript,
    FLOOR_FEERATE_SAT_PER_KW,
    Option_u32Z.constructor_none()
  )
  if (!(created instanceof Result_C2Tuple_CVec_u8Zu64ZNoneZ_OK)) {
    // Duplicated descriptor, script mismatch, or value below even the floor fee.
    return failed('ldk-create-psbt')
  }

  const parsed = parsePsbt(created.res.get_a())
  const ldkWeightWu = created.res.get_b()

  // LDK does not enforce dust on its outputs; a sub-dust output would be
  // rejected at relay after we spent both signatures on it.
  for (const output of parsed.unsignedTx.outputs) {
    if (output.valueSats < DUST_LIMIT_SATS) return failed('sub-dust-output')
  }

  const ldkInputSum = readWitnessUtxoValues(parsed).reduce((sum, v) => sum + v, 0n)
  const ldkOutputSum = parsed.unsignedTx.outputs.reduce((sum, o) => sum + o.valueSats, 0n)
  const ldkFeeSats = ldkInputSum - ldkOutputSum
  if (ldkFeeSats < 0n) return failed('negative-ldk-fee')

  return { parsed, ldkWeightWu, ldkInputSum, ldkFeeSats }
}

async function run(params: SubsidizedSweepParams): Promise<SubsidizedSweepOutcome> {
  const analysis = createLdkPsbtAtFloor(params)
  if ('status' in analysis) return analysis
  const { parsed, ldkWeightWu, ldkInputSum, ldkFeeSats } = analysis

  // Net-positive policy: never spend more on-chain than the sweep rescues.
  const minimumSubsidy = maxBigint(
    feeForWeight(
      ldkWeightWu + BDK_INPUT_WEIGHT_WU + CHANGE_OUTPUT_WEIGHT_WU,
      params.targetFeeRateSatVb
    ) - ldkFeeSats,
    0n
  )
  if (minimumSubsidy <= 0n) return failed('no-subsidy-needed')
  if (minimumSubsidy >= ldkInputSum) {
    return { status: 'not-economical', neededSubsidySats: minimumSubsidy, pendingSats: ldkInputSum }
  }

  const candidates = listConfirmedP2wpkhUtxos(params.bdkWallet)
  const selection = selectSubsidyInputs(
    candidates,
    ldkWeightWu,
    ldkFeeSats,
    params.targetFeeRateSatVb,
    params.reserveSats
  )
  if ('shortfall' in selection) {
    const { neededSubsidySats, availableSats } = selection.shortfall
    return {
      status: 'shortfall',
      neededSubsidySats,
      availableSats,
      shortfallSats: maxBigint(neededSubsidySats - availableSats, 1n),
    }
  }
  if (selection.subsidySats >= ldkInputSum) {
    return {
      status: 'not-economical',
      neededSubsidySats: selection.subsidySats,
      pendingSats: ldkInputSum,
    }
  }

  let change: { valueSats: bigint; scriptPubkey: Uint8Array } | null = null
  if (selection.changeSats !== null) {
    const changeScript = revealNextAddress(params.bdkWallet, 'Sweep subsidy change')
    // The weight math assumes a P2WPKH change output.
    if (changeScript.length !== 22) return failed('unexpected-change-script')
    change = { valueSats: selection.changeSats, scriptPubkey: changeScript }
  }

  const combined = serializePsbt(appendForeignInputsAndChange(parsed, selection.selected, change))

  // Independent check of the surgery before anything signs: BDK's parser
  // rejects malformed PSBTs, and the fee must match to the sat.
  const preSignFee = Psbt.from_string(uint8ArrayToBase64(combined)).fee_amount()?.to_sat()
  if (preSignFee !== selection.totalFeeSats) {
    captureError(
      'critical',
      'Sweep',
      `Subsidized sweep fee mismatch: computed ${selection.totalFeeSats.toString()}, PSBT says ${preSignFee?.toString() ?? 'unknown'}`
    )
    return { status: 'failed', reason: 'fee-mismatch' }
  }

  const signingDescriptors = decodeDescriptors(params.serializedDescriptors)
  if (!signingDescriptors) return failed('descriptor-decode')
  const ldkSigned = params.keysManager.sign_spendable_outputs_psbt(signingDescriptors, combined)
  if (!(ldkSigned instanceof Result_CVec_u8ZNoneZ_OK)) return failed('ldk-sign')

  const psbt = Psbt.from_string(uint8ArrayToBase64(ldkSigned.res))
  const signOpts = new SignOptions()
  // LDK-produced PSBT carries only witness_utxo for our inputs; safe for a
  // producer we trust — same rationale as the anchor-CPFP path.
  signOpts.trust_witness_utxo = true
  const finalized = params.bdkWallet.sign(psbt, signOpts)
  // extract_tx does NOT reject unfinalized inputs (it fills in what's
  // available), so the sign() return value is the only missing-signature gate.
  if (!finalized) return failed('bdk-sign-incomplete')

  const postSignFee = psbt.fee_amount()?.to_sat()
  if (postSignFee !== selection.totalFeeSats) return failed('post-sign-fee-mismatch')

  const tx = psbt.extract_tx()
  const expectedTxid = tx.compute_txid().toString()
  const txHex = bytesToHex(tx.to_bytes())

  let broadcastResult: string
  try {
    broadcastResult = await broadcastWithRetry(params.esploraUrl, txHex, params.esploraFallbackUrl)
  } catch (err: unknown) {
    return failed('broadcast', String(err))
  }

  if (broadcastResult !== expectedTxid) {
    // The broadcaster maps "inputs missing or spent" (and similar) to a
    // success sentinel. For the plain sweep that's safe; here a concurrently
    // spent BDK input produces the same error, and trusting it would delete
    // the descriptors while the funds never moved. Only believe it if the
    // esplora actually knows the tx.
    const known = await isTxKnownToEsplora(
      expectedTxid,
      params.esploraUrl,
      params.esploraFallbackUrl
    )
    if (!known) return failed('broadcast-ambiguous')
  }

  console.log(
    '[Sweep] Subsidized sweep broadcast, txid:',
    expectedTxid,
    'subsidy:',
    selection.subsidySats.toString(),
    'sats'
  )
  return { status: 'broadcast', txid: expectedTxid, subsidySats: selection.subsidySats }
}
