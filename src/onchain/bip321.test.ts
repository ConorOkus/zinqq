import { describe, it, expect } from 'vitest'
import { buildBip321Uri, parseBip321, satsToBtcString } from './bip321'

describe('buildBip321Uri', () => {
  it('builds URI with address only', () => {
    expect(buildBip321Uri({ address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' })).toBe(
      'bitcoin:TB1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KXPJZSX'
    )
  })

  it('builds URI with address and amount', () => {
    expect(
      buildBip321Uri({ address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', amountSats: 100000n })
    ).toBe('bitcoin:TB1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KXPJZSX?amount=0.00100000')
  })

  it('builds URI with address and lightning invoice', () => {
    expect(buildBip321Uri({ address: 'tb1qtest', invoice: 'lntbs1...' })).toBe(
      'bitcoin:TB1QTEST?lightning=lntbs1...'
    )
  })

  it('builds URI with address, amount, and lightning invoice', () => {
    expect(buildBip321Uri({ address: 'tb1qtest', amountSats: 50000n, invoice: 'lntbs1...' })).toBe(
      'bitcoin:TB1QTEST?amount=0.00050000&lightning=lntbs1...'
    )
  })

  it('omits amount when zero', () => {
    expect(buildBip321Uri({ address: 'tb1qtest', amountSats: 0n })).toBe('bitcoin:TB1QTEST')
  })

  it('omits amount when undefined', () => {
    expect(buildBip321Uri({ address: 'tb1qtest', amountSats: undefined })).toBe('bitcoin:TB1QTEST')
  })

  it('uppercases the address', () => {
    const uri = buildBip321Uri({ address: 'tb1qlowercase' })
    expect(uri).toBe('bitcoin:TB1QLOWERCASE')
  })

  it('builds URI with lno only (no address)', () => {
    expect(buildBip321Uri({ lno: 'lno1qgsyxjtl6luzd9t3pr62xr7eemp6awljhxc2u5' })).toBe(
      'bitcoin:?lno=lno1qgsyxjtl6luzd9t3pr62xr7eemp6awljhxc2u5'
    )
  })

  it('builds URI with address and lno', () => {
    expect(buildBip321Uri({ address: 'tb1qtest', lno: 'lno1abc' })).toBe(
      'bitcoin:TB1QTEST?lno=lno1abc'
    )
  })

  it('builds URI with address, amount, invoice, and lno', () => {
    expect(
      buildBip321Uri({
        address: 'tb1qtest',
        amountSats: 50000n,
        invoice: 'lntbs1...',
        lno: 'lno1abc',
      })
    ).toBe('bitcoin:TB1QTEST?amount=0.00050000&lightning=lntbs1...&lno=lno1abc')
  })

  it('omits lno when null', () => {
    expect(buildBip321Uri({ address: 'tb1qtest', lno: null })).toBe('bitcoin:TB1QTEST')
  })

  it('round-trips with parseBip321 for address and amount', () => {
    const uri = buildBip321Uri({
      address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      amountSats: 123456n,
    })
    const parsed = parseBip321(uri)
    expect(parsed?.address).toBe('TB1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KXPJZSX')
    expect(parsed?.amountSats).toBe(123456n)
  })
})

describe('parseBip321', () => {
  it('returns null for plain addresses', () => {
    expect(parseBip321('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseBip321('')).toBeNull()
  })

  it('parses URI with address only', () => {
    const result = parseBip321('bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')
    expect(result).toEqual({
      address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      amountSats: undefined,
    })
  })

  it('parses URI with address and amount', () => {
    const result = parseBip321('bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=0.001')
    expect(result).toEqual({
      address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      amountSats: 100000n,
    })
  })

  it('parses URI with whole BTC amount', () => {
    const result = parseBip321('bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=1')
    expect(result).toEqual({
      address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      amountSats: 100000000n,
    })
  })

  it('ignores unknown parameters', () => {
    const result = parseBip321(
      'bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=0.01&label=test&message=hello'
    )
    expect(result).toEqual({
      address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      amountSats: 1000000n,
    })
  })

  it('handles case-insensitive scheme', () => {
    const result = parseBip321('BITCOIN:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=0.5')
    expect(result).toEqual({
      address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      amountSats: 50000000n,
    })
  })

  it('returns null for bitcoin: with no address', () => {
    expect(parseBip321('bitcoin:')).toBeNull()
  })

  it('parses large amount without floating-point precision loss', () => {
    const result = parseBip321(
      'bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=21000000.00000001'
    )
    expect(result).toEqual({
      address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      amountSats: 2100000000000001n,
    })
  })

  it('treats Infinity as no amount', () => {
    const result = parseBip321('bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=Infinity')
    expect(result).toEqual({
      address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      amountSats: undefined,
    })
  })

  it('treats non-numeric amount as no amount', () => {
    const result = parseBip321('bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=abc')
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

  it('round-trips with parseBip321', () => {
    const sats = 123456n
    const btcStr = satsToBtcString(sats)
    const parsed = parseBip321(`bitcoin:tb1qtest?amount=${btcStr}`)
    expect(parsed?.amountSats).toBe(sats)
  })
})
