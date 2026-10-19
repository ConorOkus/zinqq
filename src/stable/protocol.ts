import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '../ldk/utils'

export const TRADE_TLV = 13_377_331n
export const SETTLEMENT_TLV = 13_377_333n
export const USD_UNITS = 1_000_000_000n
export const SETTLEMENT_TTL = 14 * 24 * 60 * 60
export const HEX_ID = /^[0-9a-f]{64}$/
export const REJECTIONS = [
  'invalid_amount',
  'stale_request',
  'invalid_fee',
  'invalid_quote',
  'quote_deviation',
  'insufficient_capacity',
  'settlement_required',
  'unsafe_allocation',
  'internal_failure',
] as const

export interface Correlation {
  tradeId: string
  paymentId: string
  requestHash: string
}
export type ProviderMessage =
  | {
      kind: 'sync'
      channelId: string
      expectedUsd: number
      version: bigint
      correlation: Correlation | null
    }
  | { kind: 'rejected'; channelId: string; correlation: Correlation; reason: string }
  | {
      kind: 'settlement'
      channelId: string
      expectedUsd: number
      settlementId: string
      amountMsat: bigint
      createdAt: number
      expiresAt: number
      direction: 'lsp_to_user' | 'user_to_lsp'
    }

export function usdUnits(value: number): bigint {
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 1e9)))
    throw new Error('Invalid USD amount')
  return value < 0.01 ? 0n : BigInt(Math.round(value * 1e9))
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !HEX_ID.test(value))
    throw new Error('Invalid protocol identifier')
  return value
}
function uint(value: unknown): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Unsafe protocol integer')
  return BigInt(value)
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid message')
  return value as Record<string, unknown>
}
function target(value: unknown): number {
  if (typeof value !== 'number') throw new Error('Invalid target')
  usdUnits(value)
  return value < 0.01 ? 0 : value
}
function correlation(value: Record<string, unknown>): Correlation {
  return {
    tradeId: id(value.trade_id),
    paymentId: id(value.trade_payment_id),
    requestHash: id(value.request_hash),
  }
}
export function requestHash(payload: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(payload)))
}
export function envelope(payload: string, sign: (bytes: Uint8Array) => string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ payload, signature: sign(new TextEncoder().encode(payload)) })
  )
}

export function decodeProviderMessage(
  bytes: Uint8Array,
  verify: (payload: Uint8Array, signature: string) => boolean
): ProviderMessage {
  if (bytes.length > 8192) throw new Error('Protocol message is too large')
  const outer = object(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  )
  if (
    typeof outer.payload !== 'string' ||
    typeof outer.signature !== 'string' ||
    !verify(new TextEncoder().encode(outer.payload), outer.signature)
  )
    throw new Error('Invalid provider signature')
  const value = object(JSON.parse(outer.payload) as unknown)
  const channelId = id(value.channel_id)
  if (value.type === 'SYNC_V1') {
    const hasCorrelation =
      value.trade_id !== undefined ||
      value.trade_payment_id !== undefined ||
      value.request_hash !== undefined
    const version = uint(value.sync_version)
    uint(value.backing_sats) // Validate the wire field; allocations are always derived locally.
    if (version === 0n) throw new Error('Invalid sync version')
    return {
      kind: 'sync',
      channelId,
      expectedUsd: target(value.expected_usd),
      version,
      correlation: hasCorrelation ? correlation(value) : null,
    }
  }
  if (value.type === 'TRADE_REJECTED_V1') {
    if (!REJECTIONS.some((code) => code === value.reason_code))
      throw new Error('Unknown trade rejection')
    uint(value.decided_at)
    return {
      kind: 'rejected',
      channelId,
      correlation: correlation(value),
      reason: value.reason_code as string,
    }
  }
  if (value.type === 'STABILITY_PAYMENT_V1') {
    const createdAt = Number(uint(value.created_at))
    const expiresAt = Number(uint(value.expires_at))
    const amountMsat = uint(value.amount_msat)
    if (
      amountMsat === 0n ||
      amountMsat % 1000n !== 0n ||
      expiresAt < createdAt ||
      expiresAt - createdAt > SETTLEMENT_TTL ||
      (value.direction !== 'lsp_to_user' && value.direction !== 'user_to_lsp')
    )
      throw new Error('Invalid settlement authorization')
    return {
      kind: 'settlement',
      channelId,
      expectedUsd: target(value.expected_usd),
      settlementId: id(value.settlement_id),
      amountMsat,
      createdAt,
      expiresAt,
      direction: value.direction,
    }
  }
  throw new Error('Unsupported Stable Channels message')
}

export function sameCorrelation(a: Correlation, b: Correlation): boolean {
  return a.tradeId === b.tradeId && a.paymentId === b.paymentId && a.requestHash === b.requestHash
}
