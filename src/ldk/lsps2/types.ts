/** LSPS0/LSPS2 protocol types and serialization helpers. */

// --- LSPS0 JSON-RPC transport ---

export const LSPS_MESSAGE_TYPE = 37913

export const MAX_LSPS_MESSAGE_BYTES = 65_536

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string
  method: string
  params: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string
  result?: unknown
  error?: JsonRpcError
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

// --- LSPS2 types ---

export interface OpeningFeeParams {
  minFeeMsat: bigint
  proportional: number // u32, safe as JS number
  validUntil: string // ISO 8601
  minLifetime: number
  maxClientToSelfDelay: number
  minPaymentSizeMsat: bigint
  maxPaymentSizeMsat: bigint
  promise: string
}

export interface BuyResponse {
  jitChannelScid: string
  lspCltvExpiryDelta: number
  clientTrustsLsp: boolean
}

export interface JitInvoiceResult {
  bolt11: string
  openingFeeMsat: bigint
  paymentHash: string
}

// --- LSPS2 error codes ---

export const LSPS2_ERROR_CODES = {
  CLIENT_REJECTED: 1,
  UNRECOGNIZED_OR_STALE_TOKEN: 200,
  INVALID_OPENING_FEE_PARAMS: 201,
  PAYMENT_SIZE_TOO_SMALL: 202,
  PAYMENT_SIZE_TOO_LARGE: 203,
} as const

export function lsps2ErrorMessage(code: number): string {
  switch (code) {
    case LSPS2_ERROR_CODES.UNRECOGNIZED_OR_STALE_TOKEN:
      return 'LSP token not recognized or expired'
    case LSPS2_ERROR_CODES.INVALID_OPENING_FEE_PARAMS:
      return 'Fee parameters expired, please try again'
    case LSPS2_ERROR_CODES.PAYMENT_SIZE_TOO_SMALL:
      return 'Amount too small for Lightning channel'
    case LSPS2_ERROR_CODES.PAYMENT_SIZE_TOO_LARGE:
      return 'Amount too large for this LSP'
    case LSPS2_ERROR_CODES.CLIENT_REJECTED:
      return 'LSP rejected request'
    default:
      return `LSP error (code ${code})`
  }
}

// --- Fee calculation (bLIP-52 spec compliant) ---

const U64_MAX = (1n << 64n) - 1n

export function calculateOpeningFee(paymentSizeMsat: bigint, params: OpeningFeeParams): bigint {
  const product = paymentSizeMsat * BigInt(params.proportional)
  if (product > U64_MAX) throw new Error('Fee calculation overflow: product exceeds u64')
  const sum = product + 999_999n
  if (sum > U64_MAX) throw new Error('Fee calculation overflow: sum exceeds u64')
  const proportionalFee = sum / 1_000_000n
  return proportionalFee < params.minFeeMsat ? params.minFeeMsat : proportionalFee
}

export function selectCheapestParams(
  menu: OpeningFeeParams[],
  paymentSizeMsat: bigint
): OpeningFeeParams | null {
  for (const params of menu) {
    if (paymentSizeMsat < params.minPaymentSizeMsat) continue
    if (paymentSizeMsat > params.maxPaymentSizeMsat) continue
    const fee = calculateOpeningFee(paymentSizeMsat, params)
    if (fee >= paymentSizeMsat) continue
    // Menu is ordered by increasing cost per spec; first valid entry is cheapest
    return params
  }
  return null
}

// --- Serialization ---

const KNOWN_FEE_PARAM_KEYS = new Set([
  'min_fee_msat',
  'proportional',
  'valid_until',
  'min_lifetime',
  'max_client_to_self_delay',
  'min_payment_size_msat',
  'max_payment_size_msat',
  'promise',
])

interface RawOpeningFeeParams {
  min_fee_msat: string
  proportional: number
  valid_until: string
  min_lifetime: number
  max_client_to_self_delay: number
  min_payment_size_msat: string
  max_payment_size_msat: string
  promise: string
  [key: string]: unknown
}

export function deserializeOpeningFeeParams(raw: RawOpeningFeeParams): OpeningFeeParams {
  // bLIP-52: clients MUST fail if opening_fee_params has unrecognized fields
  for (const key of Object.keys(raw)) {
    if (!KNOWN_FEE_PARAM_KEYS.has(key)) {
      throw new Error(`Unrecognized field in opening_fee_params: ${key}`)
    }
  }
  return {
    minFeeMsat: BigInt(raw.min_fee_msat),
    proportional: raw.proportional,
    validUntil: raw.valid_until,
    minLifetime: raw.min_lifetime,
    maxClientToSelfDelay: raw.max_client_to_self_delay,
    minPaymentSizeMsat: BigInt(raw.min_payment_size_msat),
    maxPaymentSizeMsat: BigInt(raw.max_payment_size_msat),
    promise: raw.promise,
  }
}

export function serializeOpeningFeeParams(params: OpeningFeeParams): RawOpeningFeeParams {
  return {
    min_fee_msat: params.minFeeMsat.toString(),
    proportional: params.proportional,
    valid_until: params.validUntil,
    min_lifetime: params.minLifetime,
    max_client_to_self_delay: params.maxClientToSelfDelay,
    min_payment_size_msat: params.minPaymentSizeMsat.toString(),
    max_payment_size_msat: params.maxPaymentSizeMsat.toString(),
    promise: params.promise,
  }
}

export function serializeJsonRpcRequest(
  id: string,
  method: string,
  params: Record<string, unknown>
): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params })
}

export function deserializeJsonRpcResponse(text: string): JsonRpcResponse {
  const parsed = JSON.parse(text) as JsonRpcResponse
  if (parsed.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC version')
  if (typeof parsed.id !== 'string') throw new Error('Missing or non-string JSON-RPC id')
  return parsed
}
