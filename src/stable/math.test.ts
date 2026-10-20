import { describe, expect, it } from 'vitest'
import { quoteAllocation, settlementDecision, receivedBacking } from './math'

describe('stable-channel allocation', () => {
  const price = 10_000_000n // $100,000/BTC, in cents
  it('quotes the upstream 1% fee and derives backing locally', () => {
    expect(quoteAllocation(0n, 0n, 10_000n, price, 200_000n, 200_000n)).toEqual({
      targetCents: 10_000n,
      backingSats: 100_000n,
      feeSats: 1_010n,
    })
  })
  it('preserves existing drift across an allocation change', () => {
    expect(
      quoteAllocation(10_000n, 100_000n, 11_000n, 11_000_000n, 200_000n, 200_000n).backingSats
    ).toBe(109_091n)
  })
  it('allocates the entire balance after the trade fee without an extra BTC buffer', () => {
    expect(quoteAllocation(0n, 0n, 9_900n, price, 100_000n, 100_000n)).toEqual({
      targetCents: 9_900n,
      backingSats: 99_000n,
      feeSats: 1_000n,
    })
    expect(() => quoteAllocation(0n, 0n, 9_901n, price, 100_000n, 100_000n)).toThrow()
  })
  it('can stabilize the channel reserve while keeping the trade fee spendable', () => {
    expect(quoteAllocation(0n, 0n, 9_900n, price, 99_000n, 100_000n).backingSats).toBe(99_000n)
  })
  it('includes sub-cent rounding dust in the initial stable backing', () => {
    expect(quoteAllocation(0n, 0n, 9_900n, price, 100_001n, 100_001n)).toEqual({
      targetCents: 9_900n,
      backingSats: 99_001n,
      feeSats: 1_000n,
    })
  })
  it('does not erase actionable drift when closing a position', () => {
    expect(() => quoteAllocation(10_000n, 100_000n, 0n, 11_000_000n, 200_000n, 200_000n)).toThrow(
      /settle/i
    )
    expect(quoteAllocation(10_000n, 100_000n, 0n, price, 200_000n, 200_000n).backingSats).toBe(0n)
  })
  it('pays only the stable surplus when BTC rises', () => {
    expect(settlementDecision(10_000n, 100_000n, 11_000_000n)).toEqual({
      action: 'pay',
      sats: 9_090n,
    })
  })
  it('waits for the provider when BTC falls', () => {
    expect(settlementDecision(10_000n, 100_000n, 9_000_000n).action).toBe('awaiting-provider')
  })
  it('requires both the 0.1% and $0.25 thresholds', () => {
    expect(settlementDecision(10_000n, 100_000n, 10_010_000n).action).toBe('stable')
    expect(settlementDecision(10_000n, 100_000n, 10_025_000n).action).toBe('pay')
  })
  it('keeps provider overpayments in native BTC', () => {
    expect(receivedBacking(100_000n, 10_000n, 9_000_000n, 20_000n, 150_000n)).toBe(111_111n)
  })
  it('never reduces above-par backing on receipt', () => {
    expect(receivedBacking(100_000n, 10_000n, 11_000_000n, 20_000n, 150_000n)).toBe(100_000n)
  })
})
