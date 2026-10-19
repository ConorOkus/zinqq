const SATS = 100_000_000n

export function settlementDecision(
  targetCents: bigint,
  backingSats: bigint,
  priceCents: bigint,
  unitsPerDollar = 100n
): {
  action: 'stable' | 'pay' | 'awaiting-provider'
  sats: bigint
} {
  if (targetCents < 0n || backingSats < 0n || priceCents <= 0n)
    throw new Error('Invalid allocation')
  const drift = backingSats * priceCents - targetCents * SATS
  const absolute = drift < 0n ? -drift : drift
  if (absolute < (unitsPerDollar * SATS) / 4n || absolute * 1000n < targetCents * SATS) {
    return { action: 'stable', sats: 0n }
  }
  return { action: drift > 0n ? 'pay' : 'awaiting-provider', sats: absolute / priceCents }
}

export function quoteAllocation(
  currentTarget: bigint,
  currentBacking: bigint,
  targetCents: bigint,
  priceCents: bigint,
  spendableSats: bigint,
  receiverSats: bigint,
  unitsPerDollar = 100n
) {
  if (targetCents < 0n || currentTarget < 0n || currentBacking < 0n || priceCents <= 0n) {
    throw new Error('Enter a valid USD target')
  }
  const delta = targetCents - currentTarget
  const feeSats = ((delta < 0n ? -delta : delta) * SATS) / ((delta > 0n ? 99n : 100n) * priceCents)
  if (spendableSats <= feeSats) throw new Error('Insufficient channel balance for the fee')
  if (
    targetCents === 0n &&
    settlementDecision(currentTarget, currentBacking, priceCents, unitsPerDollar).action !==
      'stable'
  ) {
    throw new Error('Settle the current position before closing it')
  }
  const backingSats =
    targetCents === 0n
      ? 0n
      : currentBacking + (targetCents * SATS) / priceCents - (currentTarget * SATS) / priceCents
  const limit = ((spendableSats - feeSats) * 99n) / 100n - 50n
  if (
    backingSats < 0n ||
    (targetCents > 0n && backingSats === 0n) ||
    backingSats > limit ||
    backingSats > receiverSats - feeSats
  ) {
    throw new Error('Reduce the target to leave room for the fee and channel reserve')
  }
  return { targetCents, backingSats, feeSats }
}

export function receivedBacking(
  backing: bigint,
  targetCents: bigint,
  priceCents: bigint,
  sats: bigint,
  receiverSats: bigint
): bigint {
  if (
    backing < 0n ||
    targetCents < 0n ||
    priceCents <= 0n ||
    sats <= 0n ||
    receiverSats < backing
  ) {
    throw new Error('Invalid settlement balance')
  }
  const equilibrium = (targetCents * SATS) / priceCents
  if (backing >= equilibrium) return backing
  return [backing + sats, equilibrium, receiverSats].reduce((a, b) => (a < b ? a : b))
}

export function parseUsd(text: string): bigint {
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(text.trim()))
    throw new Error('Enter USD with at most two decimal places')
  const [whole = '0', fractional = ''] = text.trim().split('.')
  return BigInt(whole) * 100n + BigInt(fractional.padEnd(2, '0'))
}

export function formatUsd(cents: bigint): string {
  const sign = cents < 0n ? '-' : ''
  const value = cents < 0n ? -cents : cents
  return `${sign}$${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`
}

export function usdNumber(cents: bigint): number {
  const value = Number(cents)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('USD value is too large')
  return value / 100
}
