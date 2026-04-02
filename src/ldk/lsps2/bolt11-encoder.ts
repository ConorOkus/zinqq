/**
 * Minimal BOLT11 invoice encoder for LSPS2 JIT channel invoices.
 *
 * Builds a BOLT11 invoice with custom route hints and signs it using
 * the node's secret key. Only supports the subset of BOLT11 needed
 * for LSPS2: payment_hash, payment_secret, description, expiry,
 * min_final_cltv_expiry, route hints, payee pubkey, and feature bits.
 *
 * Reference: https://github.com/lightning/bolts/blob/master/11-payment-encoding.md
 */

import * as secp256k1 from '@noble/secp256k1'
import { bech32 } from '@scure/base'
import { ACTIVE_NETWORK, type NetworkId } from '../config'

// --- BOLT11 constants ---

const NETWORK_PREFIX: Record<NetworkId, string> = {
  mainnet: 'lnbc',
  signet: 'lntbs',
}

// Tagged field codes (5-bit)
const TAG_PAYMENT_HASH = 1
const TAG_DESCRIPTION = 13
const TAG_PAYEE = 19
const TAG_EXPIRY = 6
const TAG_MIN_FINAL_CLTV_EXPIRY = 24
const TAG_PAYMENT_SECRET = 16
const TAG_FEATURE_BITS = 5
const TAG_ROUTE_HINT = 3

export interface RouteHintEntry {
  pubkey: Uint8Array // 33-byte compressed pubkey
  shortChannelId: bigint
  feeBaseMsat: number
  feeProportionalMillionths: number
  cltvExpiryDelta: number
}

export interface Bolt11InvoiceParams {
  amountMsat: bigint
  paymentHash: Uint8Array // 32 bytes
  paymentSecret: Uint8Array // 32 bytes
  description: string
  expirySecs: number
  minFinalCltvExpiry: number
  payeeNodeId: Uint8Array // 33-byte compressed pubkey
  routeHints: RouteHintEntry[][]
  timestamp?: number // seconds since epoch, defaults to now
}

/**
 * Encode and sign a BOLT11 invoice.
 * Returns the bech32-encoded invoice string (e.g., "lnbc10u1p..." or "lntbs10u1p...").
 */
export async function encodeBolt11Invoice(
  params: Bolt11InvoiceParams,
  nodeSecretKey: Uint8Array
): Promise<string> {
  const timestamp = params.timestamp ?? Math.floor(Date.now() / 1000)
  const hrp = buildHrp(params.amountMsat)
  const dataWords = buildDataPart(params, timestamp)

  // Sign: sha256(hrp_bytes || data_bytes) where data_bytes = 5-bit words converted to bytes
  const hrpBytes = new TextEncoder().encode(hrp)
  const dataBytes = wordsToBuffer(dataWords)

  const preimage = new Uint8Array(hrpBytes.length + dataBytes.length)
  preimage.set(hrpBytes)
  preimage.set(dataBytes, hrpBytes.length)
  const hashBuffer = await crypto.subtle.digest('SHA-256', preimage)
  const messageHash = new Uint8Array(hashBuffer)

  // Sign with recoverable signature (65 bytes: r[32] || s[32] || recovery[1])
  // prehash: false because we already hashed the message
  // signAsync uses WebCrypto internally (no setup required)
  const recoveredBytes = await secp256k1.signAsync(messageHash, nodeSecretKey, {
    prehash: false,
    format: 'recovered',
  })
  const sig = secp256k1.Signature.fromBytes(recoveredBytes, 'recovered')
  const compactSig = sig.toBytes('compact')
  const recoveryFlag = sig.recovery ?? 0

  // BOLT11: signature is 65 bytes (compact + recovery) converted to 5-bit words as one unit
  const sigFull = new Uint8Array(65)
  sigFull.set(compactSig)
  sigFull[64] = recoveryFlag
  const sigWords = bytesToWords(sigFull)

  const allWords = [...dataWords, ...sigWords]
  return bech32.encode(hrp, allWords, 2000) // BOLT11 uses bech32 with a large limit
}

// --- HRP (Human Readable Part) ---

function buildHrp(amountMsat: bigint): string {
  // Convert msat to the BOLT11 amount encoding
  // BOLT11 amounts are in the smallest denomination with a multiplier suffix
  if (amountMsat <= 0n) {
    return `${NETWORK_PREFIX[ACTIVE_NETWORK]}` // zero-amount invoice
  }

  // Find the best multiplier to express the amount
  // m = milli (0.001), u = micro (0.000001), n = nano (0.000000001), p = pico (0.000000000001)
  // Amount is in BTC, so we convert from msat -> BTC
  // 1 BTC = 100_000_000_000 msat
  const btcAmountPico = amountMsat * 10n // msat to pico-BTC

  // Try each multiplier from largest to smallest
  // milli = 10^-3 BTC = 10^9 pico-BTC
  if (btcAmountPico % 1_000_000_000n === 0n) {
    return `${NETWORK_PREFIX[ACTIVE_NETWORK]}${btcAmountPico / 1_000_000_000n}m`
  }
  // micro = 10^-6 BTC = 10^6 pico-BTC
  if (btcAmountPico % 1_000_000n === 0n) {
    return `${NETWORK_PREFIX[ACTIVE_NETWORK]}${btcAmountPico / 1_000_000n}u`
  }
  // nano = 10^-9 BTC = 10^3 pico-BTC
  if (btcAmountPico % 1_000n === 0n) {
    return `${NETWORK_PREFIX[ACTIVE_NETWORK]}${btcAmountPico / 1_000n}n`
  }
  // pico = 10^-12 BTC = 1 pico-BTC
  return `${NETWORK_PREFIX[ACTIVE_NETWORK]}${btcAmountPico}p`
}

// --- Data Part ---

function buildDataPart(params: Bolt11InvoiceParams, timestamp: number): number[] {
  const words: number[] = []

  // Timestamp: 35 bits as 7 x 5-bit words
  const ts = timestamp & 0x1ffffffff // mask to 35 bits
  for (let i = 6; i >= 0; i--) {
    words.push((ts >> (i * 5)) & 0x1f)
  }

  // Tagged fields
  addTaggedField(words, TAG_PAYMENT_HASH, bytesToWords(params.paymentHash))
  addTaggedField(words, TAG_PAYMENT_SECRET, bytesToWords(params.paymentSecret))
  addTaggedField(words, TAG_DESCRIPTION, stringToWords(params.description))
  addTaggedField(words, TAG_EXPIRY, intToWords(params.expirySecs))
  addTaggedField(words, TAG_MIN_FINAL_CLTV_EXPIRY, intToWords(params.minFinalCltvExpiry))
  addTaggedField(words, TAG_PAYEE, bytesToWords(params.payeeNodeId))

  // Feature bits: payment_secret (bit 14/15) + basic_mpp (bit 16/17)
  addTaggedField(words, TAG_FEATURE_BITS, encodeFeatureBits())

  // Route hints
  for (const route of params.routeHints) {
    const routeWords = encodeRouteHint(route)
    addTaggedField(words, TAG_ROUTE_HINT, routeWords)
  }

  return words
}

function addTaggedField(words: number[], tag: number, data: number[]): void {
  words.push(tag)
  // Data length as 2 x 5-bit words (10 bits, max 1023 words)
  const len = data.length
  words.push((len >> 5) & 0x1f)
  words.push(len & 0x1f)
  words.push(...data)
}

// --- Encoding helpers ---

/** Convert 8-bit bytes to 5-bit words (bech32 base32). */
function bytesToWords(bytes: Uint8Array): number[] {
  // Use the bech32 library's toWords which handles bit conversion correctly
  return Array.from(bech32.toWords(bytes))
}

/** Convert 5-bit words back to 8-bit bytes (includes padding bits). */
function wordsToBuffer(words: number[]): Uint8Array {
  const result: number[] = []
  let bits = 0
  let value = 0
  for (const word of words) {
    value = (value << 5) | (word & 0x1f)
    bits += 5
    while (bits >= 8) {
      bits -= 8
      result.push((value >>> bits) & 0xff)
    }
  }
  // Include remaining bits (padding) as a final byte if present
  if (bits > 0) {
    result.push((value << (8 - bits)) & 0xff)
  }
  return new Uint8Array(result)
}

/** Encode a string as 5-bit words (UTF-8 bytes -> 5-bit). */
function stringToWords(s: string): number[] {
  return bytesToWords(new TextEncoder().encode(s))
}

/** Encode a non-negative integer as 5-bit words (variable length, big-endian). */
function intToWords(n: number): number[] {
  if (n === 0) return [0]
  const words: number[] = []
  let remaining = n
  while (remaining > 0) {
    words.unshift(remaining & 0x1f)
    remaining >>= 5
  }
  return words
}

/** Encode feature bits: var_onion_optin (bit 9) + payment_secret (bit 15) + basic_mpp (bit 17). */
function encodeFeatureBits(): number[] {
  // (1 << 9) | (1 << 15) | (1 << 17) = 164352 = 0b00101_00000_10000_00000 in 20-bit / 4 words
  return [5, 0, 16, 0]
}

/** Encode a route hint (array of hops) as 5-bit words. */
function encodeRouteHint(hops: RouteHintEntry[]): number[] {
  // Each hop: pubkey(33) + short_channel_id(8) + fee_base_msat(4) + fee_proportional(4) + cltv_expiry_delta(2) = 51 bytes
  const bytes: number[] = []
  for (const hop of hops) {
    // Pubkey (33 bytes)
    for (const b of hop.pubkey) bytes.push(b)
    // Short channel ID (8 bytes, big-endian)
    const scidBytes = bigintToBytes(hop.shortChannelId, 8)
    for (const b of scidBytes) bytes.push(b)
    // Fee base msat (4 bytes, big-endian)
    bytes.push((hop.feeBaseMsat >> 24) & 0xff)
    bytes.push((hop.feeBaseMsat >> 16) & 0xff)
    bytes.push((hop.feeBaseMsat >> 8) & 0xff)
    bytes.push(hop.feeBaseMsat & 0xff)
    // Fee proportional millionths (4 bytes, big-endian)
    bytes.push((hop.feeProportionalMillionths >> 24) & 0xff)
    bytes.push((hop.feeProportionalMillionths >> 16) & 0xff)
    bytes.push((hop.feeProportionalMillionths >> 8) & 0xff)
    bytes.push(hop.feeProportionalMillionths & 0xff)
    // CLTV expiry delta (2 bytes, big-endian)
    bytes.push((hop.cltvExpiryDelta >> 8) & 0xff)
    bytes.push(hop.cltvExpiryDelta & 0xff)
  }
  return bytesToWords(new Uint8Array(bytes))
}

function bigintToBytes(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  let remaining = value
  for (let i = length - 1; i >= 0; i--) {
    bytes[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return bytes
}

// --- SCID parsing ---

/** Parse "block x tx x output" SCID string to u64 per BOLT7. */
export function parseLsps2Scid(scid: string): bigint {
  const parts = scid.split('x')
  if (parts.length !== 3) throw new Error(`Invalid SCID format: ${scid}`)
  const block = BigInt(parts[0]!.trim())
  const tx = BigInt(parts[1]!.trim())
  const output = BigInt(parts[2]!.trim())
  // BOLT7: block (24 bits), tx_index (24 bits), output (16 bits)
  if (block < 0n || block >= 1n << 24n) throw new Error(`SCID block out of range: ${block}`)
  if (tx < 0n || tx >= 1n << 24n) throw new Error(`SCID tx index out of range: ${tx}`)
  if (output < 0n || output >= 1n << 16n) throw new Error(`SCID output out of range: ${output}`)
  return (block << 40n) | (tx << 16n) | output
}
