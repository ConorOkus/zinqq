import { hexToBytes } from './utils'

/**
 * Minimal BIP-174 (PSBT v0) byte-level parsing and manipulation.
 *
 * Hand-rolled because no installed library can do what the fee-subsidized
 * sweep needs: the wasm BDK `Psbt` class is read-only (no way to add inputs)
 * and BDK's `TxBuilder` has no foreign-UTXO support, while LDK's
 * `create_spendable_outputs_psbt` spends only its own descriptors. This module
 * appends wallet-owned P2WPKH inputs (and an optional change output) to the
 * LDK-created PSBT before either side signs.
 *
 * Scope is deliberately narrow: parse, append, re-serialize. Pre-existing
 * input/output maps are carried as opaque byte slices and never rewritten, so
 * whatever LDK put there survives untouched. Wasm-free by design so it runs
 * under vitest without loading bindings.
 */

export class PsbtError extends Error {}

const PSBT_MAGIC = Uint8Array.from([0x70, 0x73, 0x62, 0x74, 0xff])
/** BIP-174 global key type for the unsigned transaction. */
const GLOBAL_UNSIGNED_TX = 0x00
/** BIP-174 per-input key type for witness_utxo. */
const IN_WITNESS_UTXO = 0x01
/** Opts in to BIP 125 replacement while keeping locktime enforceable. */
const RBF_SEQUENCE = 0xfffffffd

export interface UnsignedTxIn {
  /** 32-byte prev txid in internal (little-endian hash) byte order. */
  prevTxid: Uint8Array
  vout: number
  sequence: number
}

export interface UnsignedTxOut {
  valueSats: bigint
  scriptPubkey: Uint8Array
}

export interface UnsignedTx {
  version: number
  inputs: UnsignedTxIn[]
  outputs: UnsignedTxOut[]
  locktime: number
}

export interface ParsedPsbt {
  /** Global key-value pairs other than the unsigned tx, raw and order-preserved. */
  otherGlobalKvs: { key: Uint8Array; value: Uint8Array }[]
  unsignedTx: UnsignedTx
  /**
   * Raw per-input map bytes (key-value stream including the 0x00 terminator),
   * index-aligned with unsignedTx.inputs. Same for outputMaps.
   */
  inputMaps: Uint8Array[]
  outputMaps: Uint8Array[]
}

/** A wallet-owned P2WPKH UTXO to add as a fee-contributing input. */
export interface ForeignInput {
  /** Txid in display (big-endian) order, as BDK reports it. */
  txidDisplayHex: string
  vout: number
  valueSats: bigint
  scriptPubkey: Uint8Array
}

class ByteReader {
  private offset = 0
  private readonly bytes: Uint8Array
  private readonly view: DataView

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get position(): number {
    return this.offset
  }

  get remaining(): number {
    return this.bytes.length - this.offset
  }

  readBytes(n: number): Uint8Array {
    if (this.remaining < n) throw new PsbtError('Unexpected end of data')
    const slice = this.bytes.slice(this.offset, this.offset + n)
    this.offset += n
    return slice
  }

  readU32(): number {
    if (this.remaining < 4) throw new PsbtError('Unexpected end of data')
    const value = this.view.getUint32(this.offset, true)
    this.offset += 4
    return value
  }

  readI32(): number {
    if (this.remaining < 4) throw new PsbtError('Unexpected end of data')
    const value = this.view.getInt32(this.offset, true)
    this.offset += 4
    return value
  }

  readU64(): bigint {
    if (this.remaining < 8) throw new PsbtError('Unexpected end of data')
    const value = this.view.getBigUint64(this.offset, true)
    this.offset += 8
    return value
  }

  /** Bitcoin CompactSize. */
  readVarint(): bigint {
    const first = this.readBytes(1)[0]!
    if (first < 0xfd) return BigInt(first)
    if (first === 0xfd) {
      if (this.remaining < 2) throw new PsbtError('Truncated varint')
      const value = this.view.getUint16(this.offset, true)
      this.offset += 2
      return BigInt(value)
    }
    if (first === 0xfe) return BigInt(this.readU32())
    return this.readU64()
  }

  /** Varint that must fit a JS number (counts and lengths). */
  readVarintNumber(): number {
    const value = this.readVarint()
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new PsbtError('Varint too large')
    return Number(value)
  }
}

export function readVarint(bytes: Uint8Array, offset: number): { value: bigint; size: number } {
  const reader = new ByteReader(bytes.slice(offset))
  const value = reader.readVarint()
  return { value, size: reader.position }
}

export function writeVarint(n: bigint): Uint8Array {
  if (n < 0n) throw new PsbtError('Negative varint')
  if (n < 0xfdn) return Uint8Array.from([Number(n)])
  const buf = new Uint8Array(9)
  const view = new DataView(buf.buffer)
  if (n <= 0xffffn) {
    buf[0] = 0xfd
    view.setUint16(1, Number(n), true)
    return buf.slice(0, 3)
  }
  if (n <= 0xffffffffn) {
    buf[0] = 0xfe
    view.setUint32(1, Number(n), true)
    return buf.slice(0, 5)
  }
  buf[0] = 0xff
  view.setBigUint64(1, n, true)
  return buf
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function writeU32(value: number): Uint8Array {
  const buf = new Uint8Array(4)
  new DataView(buf.buffer).setUint32(0, value, true)
  return buf
}

function writeI32(value: number): Uint8Array {
  const buf = new Uint8Array(4)
  new DataView(buf.buffer).setInt32(0, value, true)
  return buf
}

/**
 * Parse the unsigned transaction embedded in a PSBT. Always the legacy
 * (non-witness) serialization: BIP-174 forbids scriptSigs and witnesses here.
 */
export function parseUnsignedTx(bytes: Uint8Array): UnsignedTx {
  const reader = new ByteReader(bytes)
  const version = reader.readI32()

  const inputCount = reader.readVarintNumber()
  const inputs: UnsignedTxIn[] = []
  for (let i = 0; i < inputCount; i++) {
    const prevTxid = reader.readBytes(32)
    const vout = reader.readU32()
    const scriptSigLen = reader.readVarintNumber()
    if (scriptSigLen !== 0) throw new PsbtError('Unsigned tx input has non-empty scriptSig')
    const sequence = reader.readU32()
    inputs.push({ prevTxid, vout, sequence })
  }

  const outputCount = reader.readVarintNumber()
  const outputs: UnsignedTxOut[] = []
  for (let i = 0; i < outputCount; i++) {
    const valueSats = reader.readU64()
    const scriptLen = reader.readVarintNumber()
    const scriptPubkey = reader.readBytes(scriptLen)
    outputs.push({ valueSats, scriptPubkey })
  }

  const locktime = reader.readU32()
  if (reader.remaining !== 0) throw new PsbtError('Trailing bytes after unsigned tx')
  return { version, inputs, outputs, locktime }
}

export function serializeUnsignedTx(tx: UnsignedTx): Uint8Array {
  const parts: Uint8Array[] = [writeI32(tx.version), writeVarint(BigInt(tx.inputs.length))]
  for (const input of tx.inputs) {
    if (input.prevTxid.length !== 32) throw new PsbtError('prevTxid must be 32 bytes')
    parts.push(input.prevTxid, writeU32(input.vout), writeVarint(0n), writeU32(input.sequence))
  }
  parts.push(writeVarint(BigInt(tx.outputs.length)))
  for (const output of tx.outputs) {
    parts.push(serializeTxOut(output))
  }
  parts.push(writeU32(tx.locktime))
  return concatBytes(parts)
}

export function serializeTxOut(output: UnsignedTxOut): Uint8Array {
  const value = new Uint8Array(8)
  new DataView(value.buffer).setBigUint64(0, output.valueSats, true)
  return concatBytes([value, writeVarint(BigInt(output.scriptPubkey.length)), output.scriptPubkey])
}

/** Read one key-value map, returning its raw bytes including the terminator. */
function readRawMap(reader: ByteReader, bytes: Uint8Array): Uint8Array {
  const start = reader.position
  for (;;) {
    const keyLen = reader.readVarintNumber()
    if (keyLen === 0) break
    reader.readBytes(keyLen)
    const valueLen = reader.readVarintNumber()
    reader.readBytes(valueLen)
  }
  return bytes.slice(start, reader.position)
}

function iterateMapKvs(map: Uint8Array): { key: Uint8Array; value: Uint8Array }[] {
  const reader = new ByteReader(map)
  const kvs: { key: Uint8Array; value: Uint8Array }[] = []
  for (;;) {
    const keyLen = reader.readVarintNumber()
    if (keyLen === 0) break
    const key = reader.readBytes(keyLen)
    const valueLen = reader.readVarintNumber()
    const value = reader.readBytes(valueLen)
    kvs.push({ key, value })
  }
  if (reader.remaining !== 0) throw new PsbtError('Trailing bytes in map')
  return kvs
}

export function parsePsbt(bytes: Uint8Array): ParsedPsbt {
  const reader = new ByteReader(bytes)
  const magic = reader.readBytes(5)
  for (let i = 0; i < 5; i++) {
    if (magic[i] !== PSBT_MAGIC[i]) throw new PsbtError('Bad PSBT magic')
  }

  let unsignedTxBytes: Uint8Array | null = null
  const otherGlobalKvs: { key: Uint8Array; value: Uint8Array }[] = []
  for (;;) {
    const keyLen = reader.readVarintNumber()
    if (keyLen === 0) break
    const key = reader.readBytes(keyLen)
    const valueLen = reader.readVarintNumber()
    const value = reader.readBytes(valueLen)
    if (key.length === 1 && key[0] === GLOBAL_UNSIGNED_TX) {
      if (unsignedTxBytes !== null) throw new PsbtError('Duplicate global unsigned tx')
      unsignedTxBytes = value
    } else {
      otherGlobalKvs.push({ key, value })
    }
  }
  if (unsignedTxBytes === null) throw new PsbtError('Missing global unsigned tx')

  const unsignedTx = parseUnsignedTx(unsignedTxBytes)

  const inputMaps: Uint8Array[] = []
  for (let i = 0; i < unsignedTx.inputs.length; i++) {
    inputMaps.push(readRawMap(reader, bytes))
  }
  const outputMaps: Uint8Array[] = []
  for (let i = 0; i < unsignedTx.outputs.length; i++) {
    outputMaps.push(readRawMap(reader, bytes))
  }

  if (reader.remaining !== 0) throw new PsbtError('Trailing bytes after PSBT maps')
  return { otherGlobalKvs, unsignedTx, inputMaps, outputMaps }
}

export function serializePsbt(psbt: ParsedPsbt): Uint8Array {
  if (psbt.inputMaps.length !== psbt.unsignedTx.inputs.length)
    throw new PsbtError('Input map count mismatch')
  if (psbt.outputMaps.length !== psbt.unsignedTx.outputs.length)
    throw new PsbtError('Output map count mismatch')

  const txBytes = serializeUnsignedTx(psbt.unsignedTx)
  const parts: Uint8Array[] = [
    PSBT_MAGIC,
    // Key type 0 sorts first, matching what rust-bitcoin emits — keeps
    // parse→serialize round-trips byte-identical.
    writeVarint(1n),
    Uint8Array.from([GLOBAL_UNSIGNED_TX]),
    writeVarint(BigInt(txBytes.length)),
    txBytes,
  ]
  for (const { key, value } of psbt.otherGlobalKvs) {
    parts.push(writeVarint(BigInt(key.length)), key, writeVarint(BigInt(value.length)), value)
  }
  parts.push(Uint8Array.from([0x00]))
  parts.push(...psbt.inputMaps, ...psbt.outputMaps)
  return concatBytes(parts)
}

/** A per-input map holding exactly one witness_utxo entry. */
function buildWitnessUtxoMap(input: ForeignInput): Uint8Array {
  const txout = serializeTxOut({ valueSats: input.valueSats, scriptPubkey: input.scriptPubkey })
  return concatBytes([
    writeVarint(1n),
    Uint8Array.from([IN_WITNESS_UTXO]),
    writeVarint(BigInt(txout.length)),
    txout,
    Uint8Array.from([0x00]),
  ])
}

/**
 * Append fee-contributing P2WPKH inputs and an optional change output to a
 * parsed PSBT. Existing inputs, outputs, and their maps are untouched (LDK's
 * CSV sequences and locktime survive). Returns a new ParsedPsbt.
 */
export function appendForeignInputsAndChange(
  psbt: ParsedPsbt,
  inputs: ForeignInput[],
  change: UnsignedTxOut | null
): ParsedPsbt {
  if (inputs.length === 0) throw new PsbtError('No foreign inputs to append')
  if (psbt.unsignedTx.inputs.length + inputs.length > 200)
    throw new PsbtError('Refusing to build a transaction with more than 200 inputs')

  const newInputs = inputs.map((input) => ({
    // BDK reports display order; the wire format wants internal order.
    prevTxid: hexToBytes(input.txidDisplayHex).reverse(),
    vout: input.vout,
    sequence: RBF_SEQUENCE,
  }))

  return {
    otherGlobalKvs: psbt.otherGlobalKvs,
    unsignedTx: {
      version: psbt.unsignedTx.version,
      inputs: [...psbt.unsignedTx.inputs, ...newInputs],
      outputs: change ? [...psbt.unsignedTx.outputs, change] : psbt.unsignedTx.outputs,
      locktime: psbt.unsignedTx.locktime,
    },
    inputMaps: [...psbt.inputMaps, ...inputs.map(buildWitnessUtxoMap)],
    outputMaps: change ? [...psbt.outputMaps, Uint8Array.from([0x00])] : psbt.outputMaps,
  }
}

/**
 * Per-input witness_utxo values, index-aligned with the tx inputs. Throws if
 * any input lacks one — LDK populates witness_utxo for every descriptor type,
 * so absence means an unexpected producer and the sweep must not proceed.
 */
export function readWitnessUtxoValues(psbt: ParsedPsbt): bigint[] {
  return psbt.inputMaps.map((map, index) => {
    for (const { key, value } of iterateMapKvs(map)) {
      if (key.length === 1 && key[0] === IN_WITNESS_UTXO) {
        const reader = new ByteReader(value)
        const valueSats = reader.readU64()
        const scriptLen = reader.readVarintNumber()
        reader.readBytes(scriptLen)
        if (reader.remaining !== 0) throw new PsbtError(`Malformed witness_utxo on input ${index}`)
        return valueSats
      }
    }
    throw new PsbtError(`Input ${index} has no witness_utxo`)
  })
}
