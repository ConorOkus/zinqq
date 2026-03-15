/**
 * Format satoshis as BIP 177 ₿-prefixed comma-separated integer.
 * Examples: formatBtc(0n) → "₿0", formatBtc(50000n) → "₿50,000"
 */
export function formatBtc(satoshis: bigint | number): string {
  const n = typeof satoshis === 'bigint' ? satoshis : BigInt(satoshis)
  // BigInt doesn't support toLocaleString on all engines, so format manually
  const abs = n < 0n ? -n : n
  const str = abs.toString()
  const parts: string[] = []
  for (let i = str.length; i > 0; i -= 3) {
    parts.unshift(str.slice(Math.max(0, i - 3), i))
  }
  const formatted = parts.join(',')
  return n < 0n ? `-\u20BF${formatted}` : `\u20BF${formatted}`
}
