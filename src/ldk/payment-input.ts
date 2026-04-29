import {
  Bolt11Invoice,
  Offer,
  HumanReadableName,
  Currency,
  Option_u64Z_Some,
  Option_AmountZ_Some,
  Amount_Bitcoin,
  Result_Bolt11InvoiceParseOrSemanticErrorZ_OK,
  Result_OfferBolt12ParseErrorZ_OK,
  Result_HumanReadableNameNoneZ_OK,
} from 'lightningdevkit'
import { LDK_CONFIG } from './config'

const BECH32_RE = /^bc1[a-z0-9]{25,87}$/
const LEGACY_RE = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/
export interface LnurlPayMetadata {
  domain: string
  user: string
  callback: string
  minSendableMsat: bigint
  maxSendableMsat: bigint
  description: string
}

export type ParsedPaymentInput =
  | {
      type: 'bolt11'
      invoice: Bolt11Invoice
      raw: string
      amountMsat: bigint | null
      description: string | null
    }
  | {
      type: 'bolt12'
      offer: Offer
      raw: string
      amountMsat: bigint | null
      description: string | null
    }
  | { type: 'bip353'; name: HumanReadableName; raw: string }
  /**
   * Constructed inline by the send flow in Send.tsx, not by `classifyPaymentInput()`.
   * LNURL resolution happens asynchronously after classification, so this variant
   * is assembled directly from the resolved metadata rather than during parsing.
   */
  | { type: 'lnurl'; domain: string; user: string; metadata: LnurlPayMetadata; raw: string }
  | {
      type: 'onchain'
      address: string
      amountSats: bigint | null
    }
  | { type: 'error'; message: string }

/**
 * Classify and parse a payment input string into a structured type.
 * Handles BIP 321 URIs, lightning: URIs, BOLT 11 invoices, BOLT 12 offers,
 * BIP 353 human-readable names, and plain on-chain addresses.
 */
export function classifyPaymentInput(raw: string): ParsedPaymentInput {
  const input = raw.trim()
  const lower = input.toLowerCase()

  // BIP 321 unified URI
  if (lower.startsWith('bitcoin:')) {
    return parseBip321(input)
  }

  // lightning: URI scheme
  if (lower.startsWith('lightning:')) {
    return classifyPaymentInput(input.slice('lightning:'.length))
  }

  // BOLT 11 invoice (broad match — non-mainnet prefixes are rejected by currency check in parseBolt11)
  if (/^ln(bc|tb|tbs|bcrt)/i.test(input)) {
    return parseBolt11(input)
  }

  // BOLT 12 offer
  if (lower.startsWith('lno1')) {
    return parseBolt12Offer(input)
  }

  // BIP 353 human-readable name (user@domain, optionally with ₿ prefix)
  if (/^[\u20bf]?[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(input)) {
    return parseBip353(input)
  }

  // Fallback: treat as on-chain address if it looks like one.
  // Bech32 is case-insensitive (BIP 173), so test against lowercased input.
  // Legacy P2PKH/P2SH use base58check with mixed case, so test against original.
  if (BECH32_RE.test(lower) || LEGACY_RE.test(input)) {
    return { type: 'onchain', address: input, amountSats: null }
  }

  return { type: 'error', message: 'Unrecognized payment format' }
}

function parseBolt11(raw: string): ParsedPaymentInput {
  const result = Bolt11Invoice.constructor_from_str(raw)
  if (!(result instanceof Result_Bolt11InvoiceParseOrSemanticErrorZ_OK)) {
    return { type: 'error', message: 'Invalid Lightning invoice' }
  }
  const invoice = result.res

  // Check network — must match the active network
  if (invoice.currency() !== Currency.LDKCurrency_Bitcoin) {
    return { type: 'error', message: 'Invoice is for a different Bitcoin network' }
  }

  // Check expiry
  if (invoice.would_expire(BigInt(Math.floor(Date.now() / 1000)))) {
    return { type: 'error', message: 'Invoice has expired' }
  }

  const amountOpt = invoice.amount_milli_satoshis()
  const amountMsat = amountOpt instanceof Option_u64Z_Some ? amountOpt.some : null

  // Extract description from the signed raw invoice
  let description: string | null = null
  try {
    const desc = invoice.into_signed_raw().raw_invoice().description()
    if (desc) {
      description = desc.to_str()
    }
  } catch {
    // description is optional
  }

  return { type: 'bolt11', invoice, raw, amountMsat, description }
}

function parseBolt12Offer(raw: string): ParsedPaymentInput {
  const result = Offer.constructor_from_str(raw)
  if (!(result instanceof Result_OfferBolt12ParseErrorZ_OK)) {
    return { type: 'error', message: 'Invalid BOLT 12 offer' }
  }
  const offer = result.res

  // Validate offer chain hashes against the active network.
  // Per BOLT 12, an offer with no chains field implicitly targets Bitcoin mainnet.
  const chains = offer.chains()
  if (chains.length > 0) {
    const genesisHash = LDK_CONFIG.genesisBlockHash
    const matchesNetwork = chains.some((chainHash) => {
      // LDK returns chain hashes in protocol byte order (little-endian).
      // Reverse to display order to match LDK_CONFIG.genesisBlockHash.
      const displayHex = Array.from(chainHash)
        .reverse()
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
      return displayHex === genesisHash
    })
    if (!matchesNetwork) {
      return { type: 'error', message: 'Offer is for a different Bitcoin network' }
    }
  }
  // Empty chains = implicit mainnet per BOLT 12 spec — always valid here.

  // Check expiry
  if (offer.is_expired_no_std(BigInt(Math.floor(Date.now() / 1000)))) {
    return { type: 'error', message: 'Offer has expired' }
  }

  // Extract amount if present (Offer uses Amount type, not plain u64)
  const amountOpt = offer.amount()
  let amountMsat: bigint | null = null
  if (amountOpt instanceof Option_AmountZ_Some && amountOpt.some instanceof Amount_Bitcoin) {
    amountMsat = amountOpt.some.amount_msats
  }

  // Extract description
  let description: string | null = null
  try {
    const desc = offer.description()
    if (desc) {
      description = desc.to_str()
    }
  } catch {
    // description is optional
  }

  return { type: 'bolt12', offer, raw, amountMsat, description }
}

function parseBip353(raw: string): ParsedPaymentInput {
  const cleaned = raw.replace(/^\u20bf/, '')
  const result = HumanReadableName.constructor_from_encoded(cleaned)
  if (!(result instanceof Result_HumanReadableNameNoneZ_OK)) {
    return { type: 'error', message: 'Invalid address format' }
  }
  return { type: 'bip353', name: result.res, raw: cleaned }
}

/**
 * Parse a BIP 321 unified URI.
 * Preference order: BOLT 12 offer (lno=) > BOLT 11 invoice (lightning=) > on-chain address.
 */
function parseBip321(input: string): ParsedPaymentInput {
  const withoutScheme = input.slice('bitcoin:'.length)
  const [addressPart, queryPart] = withoutScheme.split('?', 2)
  const address = addressPart?.trim() ?? ''

  if (!queryPart && !address) {
    return { type: 'error', message: 'Empty Bitcoin URI' }
  }

  let lnoValue: string | null = null
  let lightningValue: string | null = null
  let amountBtc: string | null = null

  if (queryPart) {
    for (const pair of queryPart.split('&')) {
      if (!pair) continue
      const eq = pair.indexOf('=')
      const rawKey = eq === -1 ? pair : pair.slice(0, eq)
      const rawValue = eq === -1 ? '' : pair.slice(eq + 1)
      let key: string
      let value: string
      try {
        key = decodeURIComponent(rawKey)
        value = decodeURIComponent(rawValue)
      } catch {
        continue
      }
      const lowerKey = key.toLowerCase()
      if (lowerKey === 'lno') lnoValue = value
      else if (lowerKey === 'lightning') lightningValue = value
      else if (lowerKey === 'amount') amountBtc = value
    }
  }

  // Preference: BOLT 12 > BOLT 11 > on-chain
  if (lnoValue) {
    return parseBolt12Offer(lnoValue)
  }

  if (lightningValue) {
    return parseBolt11(lightningValue)
  }

  // On-chain fallback
  if (!address) {
    return { type: 'error', message: 'Bitcoin URI has no payment method' }
  }

  // Validate address against mainnet before accepting.
  // Bech32 is case-insensitive (BIP 173), legacy P2PKH/P2SH use original case.
  if (!BECH32_RE.test(address.toLowerCase()) && !LEGACY_RE.test(address)) {
    return { type: 'error', message: 'Address is for a different Bitcoin network' }
  }

  let amountSats: bigint | null = null
  if (amountBtc) {
    const parsed = btcStringToSats(amountBtc)
    if (parsed !== null) {
      amountSats = parsed
    }
  }

  return { type: 'onchain', address, amountSats }
}

/** Convert a BTC-denominated string to satoshis using fixed-point parsing. */
function btcStringToSats(btcStr: string): bigint | null {
  const trimmed = btcStr.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  const parts = trimmed.split('.')
  const whole = parts[0] ?? '0'
  const frac = parts[1] ?? ''
  const padded = (frac + '00000000').slice(0, 8)
  return BigInt(whole) * 100_000_000n + BigInt(padded)
}
