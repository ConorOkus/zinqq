import { describe, it, expect } from 'vitest'
import { msatToSatFloor } from './msat'

describe('msatToSatFloor', () => {
  it('converts exact multiples', () => {
    expect(msatToSatFloor(5000n)).toBe(5n)
    expect(msatToSatFloor(1000n)).toBe(1n)
    expect(msatToSatFloor(0n)).toBe(0n)
  })

  it('floors sub-sat remainders', () => {
    expect(msatToSatFloor(1999n)).toBe(1n)
    expect(msatToSatFloor(1001n)).toBe(1n)
    expect(msatToSatFloor(999n)).toBe(0n)
    expect(msatToSatFloor(1n)).toBe(0n)
  })

  it('handles large values', () => {
    expect(msatToSatFloor(100_000_000_000n)).toBe(100_000_000n)
    expect(msatToSatFloor(100_000_000_999n)).toBe(100_000_000n)
  })
})
