export interface Bip21ParseResult {
  address: string
  amountSats?: bigint
}

/** Convert a BTC-denominated string to satoshis using fixed-point parsing. */
function btcStringToSats(btcStr: string): bigint | null {
  const trimmed = btcStr.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  const [whole, frac = ''] = trimmed.split('.')
  const padded = (frac + '00000000').slice(0, 8)
  return BigInt(whole) * 100_000_000n + BigInt(padded)
}

export function parseBip21(input: string): Bip21ParseResult | null {
  if (!input.toLowerCase().startsWith('bitcoin:')) return null

  // BIP21: bitcoin:<address>?amount=<btc>&label=...
  const withoutScheme = input.slice('bitcoin:'.length)
  const [addressPart, queryPart] = withoutScheme.split('?', 2)
  const address = addressPart.trim()
  if (!address) return null

  let amountSats: bigint | undefined
  if (queryPart) {
    const params = new URLSearchParams(queryPart)
    const amountBtc = params.get('amount')
    if (amountBtc) {
      const parsed = btcStringToSats(amountBtc)
      if (parsed !== null) {
        amountSats = parsed
      }
    }
  }

  return { address, amountSats }
}
