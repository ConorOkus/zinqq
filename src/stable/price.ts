export const USD_MARKETS = [
  'Bitstamp',
  'Kraken',
  'Coinbase',
  'Bitfinex',
  'Gemini',
  'Bullish',
] as const
export const PRICE_MAX_AGE_MS = 60_000
export interface PriceObservation {
  source: string
  price: number
}
export interface PriceQuote {
  priceCents: bigint
  sources: string[]
  observedAt: number
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export function priceConsensus(observations: PriceObservation[]): Omit<PriceQuote, 'observedAt'> {
  const seen = new Set<string>()
  const valid = observations.filter(({ source, price }) => {
    if (
      !USD_MARKETS.some((market) => market === source) ||
      seen.has(source) ||
      !Number.isFinite(price) ||
      price < 1_000 ||
      price > 10_000_000
    )
      return false
    seen.add(source)
    return true
  })
  if (valid.length < 3) throw new Error('At least three independent USD markets are required')
  const anchor = median(valid.map((v) => v.price))
  const agreeing = valid.filter((v) => Math.abs(v.price - anchor) / anchor <= 0.05)
  if (agreeing.length < 3) throw new Error('At least three USD markets must agree')
  return {
    priceCents: BigInt(Math.round(median(agreeing.map((v) => v.price)) * 100)),
    sources: agreeing.map((v) => v.source),
  }
}

export function validatePriceQuote(
  raw: unknown,
  now: number,
  previous?: PriceQuote | null
): PriceQuote {
  if (typeof raw !== 'object' || raw === null) throw new Error('Invalid price response')
  const value = raw as Record<string, unknown>
  if (
    typeof value.observedAt !== 'number' ||
    !Number.isSafeInteger(value.observedAt) ||
    value.observedAt > now + 5_000 ||
    now - value.observedAt > PRICE_MAX_AGE_MS
  ) {
    throw new Error('Price quote is stale')
  }
  if (!Array.isArray(value.observations)) throw new Error('Invalid price observations')
  const observations: PriceObservation[] = []
  for (const observation of value.observations as unknown[]) {
    if (typeof observation !== 'object' || observation === null) continue
    const o = observation as Record<string, unknown>
    if (typeof o.source === 'string' && typeof o.price === 'number')
      observations.push({ source: o.source, price: o.price })
  }
  const consensus = priceConsensus(observations)
  if (
    previous &&
    now - previous.observedAt <= PRICE_MAX_AGE_MS &&
    (consensus.priceCents > (previous.priceCents * 110n) / 100n ||
      consensus.priceCents < (previous.priceCents * 90n) / 100n)
  ) {
    throw new Error('Large price move: waiting for a new market consensus')
  }
  return { ...consensus, observedAt: value.observedAt }
}

export async function fetchPrice(
  previous?: PriceQuote | null,
  signal?: AbortSignal
): Promise<PriceQuote> {
  const response = await fetch('/api/stable-price', {
    cache: 'no-store',
    signal: signal ?? AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error('USD market consensus is unavailable')
  return validatePriceQuote(await response.json(), Date.now(), previous)
}
