import {
  Psbt,
  ScriptBuf,
  SignOptions,
  Transaction,
  type Wallet,
} from '@bitcoindevkit/bdk-wallet-web'
import { bytesToHex, uint8ArrayToBase64 } from '../ldk/utils'
import { MAX_FEE_SATS } from '../onchain/config'

export interface SpliceCoin {
  outpoint: string
  value: string
  previousTx: string
}

export interface SpliceFunding {
  amountSats: string
  maxFeeSats: string
  fundingOutpoint: string
  channelValueSats: string
  /** The pre-splice funding output script, used to authenticate the shared input. */
  fundingScript: string
  changeScript: string
  inputs: SpliceCoin[]
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0))
  let offset = 0
  for (const array of arrays) {
    result.set(array, offset)
    offset += array.length
  }
  return result
}

function compactSize(n: number): Uint8Array {
  if (n < 253) return Uint8Array.of(n)
  const bytes = new Uint8Array(n <= 65535 ? 3 : 5)
  const view = new DataView(bytes.buffer)
  bytes[0] = bytes.length === 3 ? 253 : 254
  if (bytes.length === 3) view.setUint16(1, n, true)
  else view.setUint32(1, n, true)
  return bytes
}

function entry(key: Uint8Array, value: Uint8Array): Uint8Array {
  return concat(compactSize(key.length), key, compactSize(value.length), value)
}

/** Construct BIP174 data from LDK's unsigned transaction and authenticated previous transactions. */
export function splicePsbt(unsigned: Uint8Array, previous: Uint8Array[]): Psbt {
  const tx = Transaction.from_bytes(unsigned)
  if (previous.length !== tx.input.length) throw new Error('Missing splice input transactions')
  const inputMaps = previous.map((raw, index) => {
    const prev = Transaction.from_bytes(raw)
    if (prev.compute_txid().toString() !== tx.input[index]!.previous_output.txid.toString())
      throw new Error('Splice input transaction hash mismatch')
    return concat(
      entry(Uint8Array.of(0), raw),
      // SIGHASH_ALL, required by LDK for interactive funding signatures.
      entry(Uint8Array.of(3), Uint8Array.of(1, 0, 0, 0)),
      Uint8Array.of(0)
    )
  })
  return Psbt.from_string(
    uint8ArrayToBase64(
      concat(
        Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff),
        entry(Uint8Array.of(0), unsigned),
        Uint8Array.of(0),
        ...inputMaps,
        new Uint8Array(tx.output.length)
      )
    )
  )
}

/**
 * Validate a transaction copied directly from LDK's FundingTransactionReadyForSigning event.
 * LDK authenticates the negotiated funding keys and checks the returned transaction's txid.
 * Funding keys rotate during splicing, so the old script authenticates the shared input,
 * not the replacement output. We support a single P2WSH output; ambiguous requests fail closed.
 */
export function validateSpliceFunding(
  unsigned: Uint8Array,
  previous: Uint8Array[],
  reviewed: SpliceFunding,
  isMine: (script: Uint8Array) => boolean
): void {
  const tx = Transaction.from_bytes(unsigned)
  const approved = new Map(reviewed.inputs.map((coin) => [coin.outpoint, coin]))
  const seen = new Set<string>()
  let inputValue = 0n
  let ourInputs = 0n
  let change = 0n
  let funding = 0n
  let fundingOutputs = 0
  for (const [index, input] of tx.input.entries()) {
    const outpoint = input.previous_output.toString()
    if (seen.has(outpoint)) throw new Error('Duplicate splice input')
    seen.add(outpoint)
    const raw = previous[index]
    if (!raw) throw new Error('Missing splice input transaction')
    const prev = Transaction.from_bytes(raw)
    if (prev.compute_txid().toString() !== input.previous_output.txid.toString())
      throw new Error('Splice input transaction hash mismatch')
    const output = prev.tx_out(input.previous_output.vout)
    const value = output.value.to_sat()
    if (
      outpoint === reviewed.fundingOutpoint &&
      (value !== BigInt(reviewed.channelValueSats) ||
        bytesToHex(output.script_pubkey.as_bytes()) !== reviewed.fundingScript)
    )
      throw new Error('Splice shared input differs from the reviewed channel funding')
    inputValue += value
    const coin = approved.get(outpoint)
    if (coin) {
      if (value !== BigInt(coin.value) || !isMine(output.script_pubkey.as_bytes()))
        throw new Error('Splice input no longer matches the wallet')
      ourInputs += value
    } else if (isMine(output.script_pubkey.as_bytes())) {
      throw new Error('Splice tried to spend an unapproved wallet input')
    }
  }
  if (!seen.has(reviewed.fundingOutpoint) || reviewed.inputs.some((c) => !seen.has(c.outpoint)))
    throw new Error('Splice inputs differ from the review')
  let outputValue = 0n
  for (const output of tx.output) {
    const value = output.value.to_sat()
    const script = output.script_pubkey.as_bytes()
    const hex = bytesToHex(script)
    outputValue += value
    const mine = isMine(script)
    if (!mine && script.length === 34 && script[0] === 0 && script[1] === 32) {
      funding = value
      fundingOutputs++
    }
    if (mine) {
      if (hex !== reviewed.changeScript) throw new Error('Unexpected wallet output in splice')
      change += value
    }
  }
  const amount = BigInt(reviewed.amountSats)
  const maxFee = BigInt(reviewed.maxFeeSats)
  const ourFee = ourInputs - change - amount
  const totalFee = inputValue - outputValue
  if (fundingOutputs !== 1)
    throw new Error('Splice must contain one unambiguous P2WSH channel funding output')
  if (funding < BigInt(reviewed.channelValueSats) + amount)
    throw new Error('Splice does not add the reviewed amount to the channel')
  if (ourFee < 0n || ourFee > maxFee || totalFee < 0n || totalFee > MAX_FEE_SATS)
    throw new Error('Splice exceeds the reviewed mining fee')
}

export function signSpliceFunding(
  wallet: Wallet,
  unsigned: Uint8Array,
  previous: Uint8Array[],
  reviewed: SpliceFunding
): Uint8Array {
  validateSpliceFunding(unsigned, previous, reviewed, (script) =>
    wallet.is_mine(ScriptBuf.from_bytes(script))
  )
  const psbt = splicePsbt(unsigned, previous)
  wallet.sign(psbt, new SignOptions())
  return psbt.extract_tx().to_bytes()
}
