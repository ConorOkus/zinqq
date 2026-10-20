import { describe, expect, it } from 'vitest'
import { priceConsensus, validatePriceQuote } from './price'

describe('stable USD price consensus', () => {
  const observations = [
    { source: 'Coinbase', price: 100_000 },
    { source: 'Kraken', price: 100_100 },
    { source: 'Bitstamp', price: 99_900 },
    { source: 'Gemini', price: 150_000 },
  ]
  it('requires three independent markets and removes 5% outliers', () => {
    expect(priceConsensus(observations)).toEqual({
      priceCents: 10_000_000n,
      sources: ['Coinbase', 'Kraken', 'Bitstamp'],
    })
    expect(() => priceConsensus(observations.slice(0, 2))).toThrow(/three/i)
  })
  it('does not count duplicate market names as independent', () => {
    expect(() => priceConsensus([observations[0]!, observations[0]!, observations[0]!])).toThrow()
  })
  it('rejects stale quotes and implausible prices', () => {
    expect(() => validatePriceQuote({ observations, observedAt: 0 }, 61_000)).toThrow(/stale/i)
    expect(() => priceConsensus(observations.map((v) => ({ ...v, price: Infinity })))).toThrow()
  })
  it('quarantines a large move against a still-fresh anchor', () => {
    const first = validatePriceQuote({ observations, observedAt: 1_000 }, 1_000)
    expect(() =>
      validatePriceQuote(
        {
          observations: observations.map((v) => ({ ...v, price: v.price * 1.2 })),
          observedAt: 2_000,
        },
        2_000,
        first
      )
    ).toThrow(/move/i)
  })
})
