import { describe, it, expect } from 'vitest'
import { bytesToHex, hexToBytes, txidBytesToHex } from './utils'

describe('bytesToHex', () => {
  it('converts empty array', () => {
    expect(bytesToHex(new Uint8Array([]))).toBe('')
  })

  it('converts bytes to hex string', () => {
    expect(bytesToHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe('00010f10ff')
  })

  it('pads single-digit hex values', () => {
    expect(bytesToHex(new Uint8Array([0, 5]))).toBe('0005')
  })
})

describe('txidBytesToHex', () => {
  it('reverses bytes before hex encoding', () => {
    expect(txidBytesToHex(new Uint8Array([0x01, 0x02, 0x03]))).toBe('030201')
  })

  it('handles empty array', () => {
    expect(txidBytesToHex(new Uint8Array([]))).toBe('')
  })

  it('converts a 32-byte txid from internal to display order', () => {
    const internal = new Uint8Array(32)
    for (let i = 0; i < 32; i++) internal[i] = i + 1
    const hex = txidBytesToHex(internal)
    expect(hex.startsWith('20')).toBe(true)
    expect(hex.endsWith('01')).toBe(true)
  })
})

describe('hexToBytes', () => {
  it('converts empty string', () => {
    expect(Array.from(hexToBytes(''))).toEqual([])
  })

  it('converts hex string to bytes', () => {
    expect(Array.from(hexToBytes('00010f10ff'))).toEqual([0, 1, 15, 16, 255])
  })

  it('roundtrips with bytesToHex', () => {
    const original = new Uint8Array([42, 128, 255, 0, 1])
    expect(Array.from(hexToBytes(bytesToHex(original)))).toEqual(Array.from(original))
  })
})
