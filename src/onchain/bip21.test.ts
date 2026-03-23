import { describe, it, expect } from 'vitest'
import { parseBip21, satsToBtcString } from './bip21'

describe('parseBip21', () => {
  it('returns null for plain addresses', () => {
    expect(parseBip21('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseBip21('')).toBeNull()
  })

  it('parses URI with address only', () => {
    const result = parseBip21('bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')
    expect(result).toEqual({
      address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      amountSats: undefined,
    })
  })

  it('parses URI with address and amount', () => {
    const result = parseBip21('bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=0.001')
    expect(result).toEqual({
      address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      amountSats: 100000n,
    })
  })

  it('parses URI with whole BTC amount', () => {
    const result = parseBip21('bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=1')
    expect(result).toEqual({
      address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      amountSats: 100000000n,
    })
  })

  it('ignores unknown parameters', () => {
    const result = parseBip21(
      'bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=0.01&label=test&message=hello'
    )
    expect(result).toEqual({
      address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      amountSats: 1000000n,
    })
  })

  it('handles case-insensitive scheme', () => {
    const result = parseBip21('BITCOIN:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=0.5')
    expect(result).toEqual({
      address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      amountSats: 50000000n,
    })
  })

  it('returns null for bitcoin: with no address', () => {
    expect(parseBip21('bitcoin:')).toBeNull()
  })

  it('parses large amount without floating-point precision loss', () => {
    const result = parseBip21(
      'bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=21000000.00000001'
    )
    expect(result).toEqual({
      address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      amountSats: 2100000000000001n,
    })
  })

  it('treats Infinity as no amount', () => {
    const result = parseBip21('bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=Infinity')
    expect(result).toEqual({
      address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      amountSats: undefined,
    })
  })

  it('treats non-numeric amount as no amount', () => {
    const result = parseBip21('bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=abc')
    expect(result).toEqual({
      address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      amountSats: undefined,
    })
  })
})

describe('satsToBtcString', () => {
  it('converts zero sats', () => {
    expect(satsToBtcString(0n)).toBe('0.00000000')
  })

  it('converts 1 sat', () => {
    expect(satsToBtcString(1n)).toBe('0.00000001')
  })

  it('converts 50000 sats (0.0005 BTC)', () => {
    expect(satsToBtcString(50000n)).toBe('0.00050000')
  })

  it('converts 1 BTC', () => {
    expect(satsToBtcString(100_000_000n)).toBe('1.00000000')
  })

  it('converts large amount without precision loss', () => {
    expect(satsToBtcString(2_100_000_000_000_001n)).toBe('21000000.00000001')
  })

  it('throws RangeError for negative input', () => {
    expect(() => satsToBtcString(-1n)).toThrow(RangeError)
  })

  it('round-trips with parseBip21', () => {
    const sats = 123456n
    const btcStr = satsToBtcString(sats)
    const parsed = parseBip21(`bitcoin:tb1qtest?amount=${btcStr}`)
    expect(parsed?.amountSats).toBe(sats)
  })
})
