import { priceConsensus, type PriceObservation } from '../src/stable/price'

const FEEDS = [
  { source: 'Bitstamp', url: 'https://www.bitstamp.net/api/v2/ticker/btcusd/', path: ['last'] },
  {
    source: 'Kraken',
    url: 'https://api.kraken.com/0/public/Ticker?pair=XXBTZUSD',
    path: ['result', 'XXBTZUSD', 'c', '0'],
  },
  {
    source: 'Coinbase',
    url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot',
    path: ['data', 'amount'],
  },
  { source: 'Bitfinex', url: 'https://api-pub.bitfinex.com/v2/ticker/tBTCUSD', path: ['6'] },
  { source: 'Gemini', url: 'https://api.gemini.com/v1/pubticker/btcusd', path: ['last'] },
  {
    source: 'Bullish',
    url: 'https://api.exchange.bullish.com/trading-api/v1/markets/BTCUSD/tick',
    path: ['last'],
  },
] as const

export async function GET() {
  const observedAt = Date.now()
  const results = await Promise.allSettled(
    FEEDS.map(async (feed): Promise<PriceObservation> => {
      const response = await fetch(feed.url, {
        signal: AbortSignal.timeout(8_000),
        cache: 'no-store',
        redirect: 'error',
      })
      if (!response.ok) throw new Error('Market unavailable')
      let value: unknown = await response.json()
      for (const key of feed.path) {
        if (typeof value !== 'object' || value === null) throw new Error('Invalid market response')
        value = (value as Record<string, unknown>)[key]
      }
      if (typeof value !== 'string' && typeof value !== 'number')
        throw new Error('Invalid market price')
      return { source: feed.source, price: Number(value) }
    })
  )
  const observations = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : []
  )
  try {
    priceConsensus(observations)
    return Response.json({ observations, observedAt }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return Response.json(
      { error: 'At least three agreeing USD markets are required' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    )
  }
}
