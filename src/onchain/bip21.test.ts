import { describe, it, expect } from 'vitest'
import { parseBip21 } from './bip21'

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
      'bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=0.01&label=test&message=hello',
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
    const result = parseBip21('bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=21000000.00000001')
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
