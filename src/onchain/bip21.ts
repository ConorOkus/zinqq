export interface Bip21ParseResult {
  address: string
  amountSats?: bigint
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
      amountSats = BigInt(Math.round(parseFloat(amountBtc) * 1e8))
    }
  }

  return { address, amountSats }
}
