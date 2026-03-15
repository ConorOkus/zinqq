import { describe, it, expect } from 'vitest'
import { formatBtc } from './format-btc'

describe('formatBtc', () => {
  it('formats zero', () => {
    expect(formatBtc(0n)).toBe('₿0')
    expect(formatBtc(0)).toBe('₿0')
  })

  it('formats small amounts without commas', () => {
    expect(formatBtc(1n)).toBe('₿1')
    expect(formatBtc(999n)).toBe('₿999')
  })

  it('formats amounts with comma separation', () => {
    expect(formatBtc(1000n)).toBe('₿1,000')
    expect(formatBtc(50000n)).toBe('₿50,000')
    expect(formatBtc(1234567n)).toBe('₿1,234,567')
    expect(formatBtc(100000000n)).toBe('₿100,000,000')
  })

  it('handles number inputs', () => {
    expect(formatBtc(50000)).toBe('₿50,000')
    expect(formatBtc(100000000)).toBe('₿100,000,000')
  })

  it('handles large values (BigInt safe)', () => {
    expect(formatBtc(2100000000000000n)).toBe('₿2,100,000,000,000,000')
  })

  it('handles negative amounts', () => {
    expect(formatBtc(-50000n)).toBe('-₿50,000')
    expect(formatBtc(-1n)).toBe('-₿1')
  })
})
