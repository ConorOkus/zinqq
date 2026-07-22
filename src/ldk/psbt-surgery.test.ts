import { describe, it, expect } from 'vitest'
import {
  parsePsbt,
  serializePsbt,
  parseUnsignedTx,
  serializeUnsignedTx,
  serializeTxOut,
  appendForeignInputsAndChange,
  readWitnessUtxoValues,
  readVarint,
  writeVarint,
  PsbtError,
  type ForeignInput,
} from './psbt-surgery'
import { bytesToHex, hexToBytes } from './utils'

/**
 * BIP-174 spec test vector: "PSBT with one P2PKH input. Outputs are empty."
 * Unsigned tx: version 2, one input (empty scriptSig, sequence 0xfffffffe),
 * two outputs, locktime 1257139. The input map carries a non_witness_utxo.
 */
const BIP174_VALID_VECTOR_BASE64 =
  'cHNidP8BAHUCAAAAASaBcTce3/KF6Tet7qSze3gADAVmy7OtZGQXE8pCFxv2AAAAAAD+////AtPf9QUAAAAAGXapFNDFmQPFusKGh2DpD9UhpGZap2UgiKwA4fUFAAAAABepFDVF5uM7gyxHBQ8k0+65PJwDlIvHh7MuEwAAAQD9pQEBAAAAAAECiaPHHqtNIOA3G7ukzGmPopXJRjr6Ljl/hTPMti+VZ+UBAAAAFxYAFL4Y0VKpsBIDna89p95PUzSe7LmF/////4b4qkOnHf8USIk6UwpyN+9rRgi7st0tAXHmOuxqSJC0AQAAABcWABT+Pp7xp0XpdNkCxDVZQ6vLNL1TU/////8CAMLrCwAAAAAZdqkUhc/xCX/Z4Ai7NK9wnGIZeziXikiIrHL++E4sAAAAF6kUM5cluiHv1irHU6m80GfWx6ajnQWHAkcwRAIgJxK+IuAnDzlPVoMR3HyppolwuAJf3TskAinwf4pfOiQCIAGLONfc0xTnNMkna9b7QPZzMlvEuqFEyADS8vAtsnZcASED0uFWdJQbrUqZY3LLh+GFbTZSYG2YVi/jnF6efkE/IQUCSDBFAiEA0SuFLYXc2WHS9fSrZgZU327tzHlMDDPOXMMJ/7X85Y0CIGczio4OFyXBl/saiK9Z9R5E5CVbIBZ8hoQDHAXR8lkqASECI7cr7vCWXRC+B3jv7NYfysb3mk6haTkzgHNEZPhPKrMAAAAAAAAA'

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const goldenBytes = () => base64ToBytes(BIP174_VALID_VECTOR_BASE64)

const P2WPKH_SCRIPT_A = hexToBytes('0014aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
const P2WPKH_SCRIPT_B = hexToBytes('0014bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
const TXID_A = '11'.repeat(32)
const TXID_B = '22'.repeat(32)

describe('varint', () => {
  it.each([
    [0n, 1],
    [1n, 1],
    [252n, 1],
    [253n, 3],
    [0xffffn, 3],
    [0x10000n, 5],
    [0xffffffffn, 5],
    [0x100000000n, 9],
  ])('round-trips %s with %i byte(s)', (value, size) => {
    const encoded = writeVarint(value)
    expect(encoded.length).toBe(size)
    expect(readVarint(encoded, 0)).toEqual({ value, size })
  })

  it('rejects negative values', () => {
    expect(() => writeVarint(-1n)).toThrow(PsbtError)
  })
})

describe('parsePsbt (BIP-174 golden vector)', () => {
  it('parses the spec vector structure', () => {
    const psbt = parsePsbt(goldenBytes())

    expect(psbt.otherGlobalKvs).toHaveLength(0)
    expect(psbt.unsignedTx.version).toBe(2)
    expect(psbt.unsignedTx.locktime).toBe(1257139)

    expect(psbt.unsignedTx.inputs).toHaveLength(1)
    const input = psbt.unsignedTx.inputs[0]!
    expect(input.sequence).toBe(0xfffffffe)
    expect(input.vout).toBe(0)
    // Spec txid is display order; wire format stores it reversed.
    expect(bytesToHex(Uint8Array.from(input.prevTxid).reverse())).toBe(
      'f61b1742ca13176464adb3cb66050c00787bb3a4eead37e985f2df1e37718126'
    )

    expect(psbt.unsignedTx.outputs).toHaveLength(2)
    expect(psbt.unsignedTx.outputs[0]!.valueSats).toBe(99999699n)
    expect(bytesToHex(psbt.unsignedTx.outputs[0]!.scriptPubkey)).toBe(
      '76a914d0c59903c5bac2868760e90fd521a4665aa7652088ac'
    )
    expect(psbt.unsignedTx.outputs[1]!.valueSats).toBe(100000000n)

    expect(psbt.inputMaps).toHaveLength(1)
    expect(psbt.outputMaps).toHaveLength(2)
    // Both output maps are empty (just the terminator).
    expect(psbt.outputMaps[0]).toEqual(Uint8Array.from([0x00]))
    expect(psbt.outputMaps[1]).toEqual(Uint8Array.from([0x00]))
  })

  it('serialize(parse(vector)) is byte-identical', () => {
    const bytes = goldenBytes()
    expect(bytesToHex(serializePsbt(parsePsbt(bytes)))).toBe(bytesToHex(bytes))
  })

  it('unsigned tx codec round-trips', () => {
    const psbt = parsePsbt(goldenBytes())
    const reserialized = serializeUnsignedTx(psbt.unsignedTx)
    expect(parseUnsignedTx(reserialized)).toEqual(psbt.unsignedTx)
  })
})

describe('parsePsbt (malformed input)', () => {
  it('rejects bad magic', () => {
    const bytes = goldenBytes()
    bytes[4] = 0x00
    expect(() => parsePsbt(bytes)).toThrow('Bad PSBT magic')
  })

  it('rejects truncated data', () => {
    expect(() => parsePsbt(goldenBytes().slice(0, 40))).toThrow(PsbtError)
  })

  it('rejects trailing bytes', () => {
    const bytes = goldenBytes()
    const extended = new Uint8Array(bytes.length + 1)
    extended.set(bytes)
    expect(() => parsePsbt(extended)).toThrow('Trailing bytes after PSBT maps')
  })

  it('rejects a missing global unsigned tx', () => {
    // magic + empty global map
    const bytes = Uint8Array.from([0x70, 0x73, 0x62, 0x74, 0xff, 0x00])
    expect(() => parsePsbt(bytes)).toThrow('Missing global unsigned tx')
  })

  it('rejects a non-empty scriptSig in the unsigned tx', () => {
    const tx = hexToBytes(
      // version 2 | 1 input | txid | vout 0 | scriptSig len 1 + OP_TRUE | sequence | 0 outputs | locktime
      '02000000' + '01' + '00'.repeat(32) + '00000000' + '0151' + 'ffffffff' + '00' + '00000000'
    )
    expect(() => parseUnsignedTx(tx)).toThrow('non-empty scriptSig')
  })
})

describe('serializeTxOut', () => {
  it('produces golden bytes for a P2WPKH output', () => {
    const bytes = serializeTxOut({ valueSats: 1000n, scriptPubkey: P2WPKH_SCRIPT_A })
    expect(bytesToHex(bytes)).toBe(
      'e803000000000000' + '16' + '0014aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
  })
})

describe('appendForeignInputsAndChange', () => {
  const foreignInputs: ForeignInput[] = [
    { txidDisplayHex: TXID_A, vout: 1, valueSats: 50_000n, scriptPubkey: P2WPKH_SCRIPT_A },
    { txidDisplayHex: TXID_B, vout: 0, valueSats: 20_000n, scriptPubkey: P2WPKH_SCRIPT_B },
  ]
  const change = { valueSats: 48_020n, scriptPubkey: P2WPKH_SCRIPT_B }

  it('appends inputs, witness_utxo maps, and a change output', () => {
    const original = parsePsbt(goldenBytes())
    const modified = appendForeignInputsAndChange(original, foreignInputs, change)

    expect(modified.unsignedTx.inputs).toHaveLength(3)
    // Original input untouched.
    expect(modified.unsignedTx.inputs[0]).toEqual(original.unsignedTx.inputs[0])
    expect(modified.inputMaps[0]).toEqual(original.inputMaps[0])
    // Appended inputs: display-order txid reversed to wire order, RBF sequence.
    expect(bytesToHex(modified.unsignedTx.inputs[1]!.prevTxid)).toBe(TXID_A)
    expect(bytesToHex(modified.unsignedTx.inputs[2]!.prevTxid)).toBe(TXID_B)
    expect(modified.unsignedTx.inputs[1]!.vout).toBe(1)
    expect(modified.unsignedTx.inputs[1]!.sequence).toBe(0xfffffffd)
    expect(modified.unsignedTx.inputs[2]!.sequence).toBe(0xfffffffd)
    // Locktime preserved.
    expect(modified.unsignedTx.locktime).toBe(1257139)

    // Change appended last, with an empty output map.
    expect(modified.unsignedTx.outputs).toHaveLength(3)
    expect(modified.unsignedTx.outputs[2]).toEqual(change)
    expect(modified.outputMaps).toHaveLength(3)
    expect(modified.outputMaps[2]).toEqual(Uint8Array.from([0x00]))

    // Golden bytes for the appended witness_utxo map:
    // keylen 1 | keytype 0x01 | valuelen 0x1f | txout (8B value + len + script) | terminator
    expect(bytesToHex(modified.inputMaps[1]!)).toBe(
      '01' + '01' + '1f' + '50c3000000000000' + '16' + bytesToHex(P2WPKH_SCRIPT_A) + '00'
    )

    // The result survives a full serialize → parse round trip.
    const reparsed = parsePsbt(serializePsbt(modified))
    expect(reparsed.unsignedTx).toEqual(modified.unsignedTx)
    expect(reparsed.inputMaps).toEqual(modified.inputMaps)
    expect(reparsed.outputMaps).toEqual(modified.outputMaps)
  })

  it('omits the change output when null', () => {
    const modified = appendForeignInputsAndChange(parsePsbt(goldenBytes()), foreignInputs, null)
    expect(modified.unsignedTx.outputs).toHaveLength(2)
    expect(modified.outputMaps).toHaveLength(2)
    expect(modified.unsignedTx.inputs).toHaveLength(3)
  })

  it('does not mutate the original ParsedPsbt', () => {
    const original = parsePsbt(goldenBytes())
    appendForeignInputsAndChange(original, foreignInputs, change)
    expect(original.unsignedTx.inputs).toHaveLength(1)
    expect(original.unsignedTx.outputs).toHaveLength(2)
    expect(original.inputMaps).toHaveLength(1)
    expect(original.outputMaps).toHaveLength(2)
  })

  it('rejects an empty foreign input list', () => {
    expect(() => appendForeignInputsAndChange(parsePsbt(goldenBytes()), [], change)).toThrow(
      PsbtError
    )
  })
})

describe('readWitnessUtxoValues', () => {
  it('reads values from appended witness_utxo maps', () => {
    const modified = appendForeignInputsAndChange(
      parsePsbt(goldenBytes()),
      [
        { txidDisplayHex: TXID_A, vout: 1, valueSats: 50_000n, scriptPubkey: P2WPKH_SCRIPT_A },
        { txidDisplayHex: TXID_B, vout: 0, valueSats: 20_000n, scriptPubkey: P2WPKH_SCRIPT_B },
      ],
      null
    )
    // The golden vector's own input has only non_witness_utxo, so reading all
    // values must throw...
    expect(() => readWitnessUtxoValues(modified)).toThrow('Input 0 has no witness_utxo')
    // ...but a PSBT whose inputs all carry witness_utxo reads cleanly.
    const witnessOnly = {
      ...modified,
      unsignedTx: { ...modified.unsignedTx, inputs: modified.unsignedTx.inputs.slice(1) },
      inputMaps: modified.inputMaps.slice(1),
    }
    expect(readWitnessUtxoValues(witnessOnly)).toEqual([50_000n, 20_000n])
  })
})
