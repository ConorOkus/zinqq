import { describe, it, expect } from 'vitest'
import {
  calculateOpeningFee,
  selectCheapestParams,
  deserializeOpeningFeeParams,
  serializeOpeningFeeParams,
  serializeJsonRpcRequest,
  deserializeJsonRpcResponse,
  lsps2ErrorMessage,
  type OpeningFeeParams,
} from './types'

function makeParams(overrides: Partial<OpeningFeeParams> = {}): OpeningFeeParams {
  return {
    minFeeMsat: 546_000n,
    proportional: 1200,
    validUntil: '2030-01-01T00:00:00.000Z',
    minLifetime: 1008,
    maxClientToSelfDelay: 2016,
    minPaymentSizeMsat: 10_000n,
    maxPaymentSizeMsat: 1_000_000_000n,
    promise: 'abc123',
    ...overrides,
  }
}

describe('calculateOpeningFee', () => {
  it('returns min_fee when proportional fee is less', () => {
    const params = makeParams({ minFeeMsat: 546_000n, proportional: 1200 })
    // 100_000 * 1200 / 1_000_000 = 120 (< 546_000)
    expect(calculateOpeningFee(100_000n, params)).toBe(546_000n)
  })

  it('returns proportional fee when greater than min_fee', () => {
    const params = makeParams({ minFeeMsat: 100n, proportional: 10_000 })
    // 1_000_000 * 10_000 = 10_000_000_000; ceil(10_000_000_000 / 1_000_000) = 10_000
    expect(calculateOpeningFee(1_000_000n, params)).toBe(10_000n)
  })

  it('rounds up correctly (ceiling division)', () => {
    const params = makeParams({ minFeeMsat: 0n, proportional: 1 })
    // 1_000_001 * 1 + 999_999 = 2_000_000; / 1_000_000 = 2
    expect(calculateOpeningFee(1_000_001n, params)).toBe(2n)
  })

  it('handles zero payment size', () => {
    const params = makeParams({ minFeeMsat: 546_000n })
    expect(calculateOpeningFee(0n, params)).toBe(546_000n)
  })

  it('throws on u64 overflow in multiplication', () => {
    const params = makeParams({ proportional: 4_000_000_000 }) // near u32 max
    const hugePayment = 1n << 63n // large but valid u64
    expect(() => calculateOpeningFee(hugePayment, params)).toThrow('overflow')
  })

  it('handles exact boundary of min_fee', () => {
    const params = makeParams({ minFeeMsat: 1000n, proportional: 1000 })
    // payment=1_000_000: fee = ceil(1_000_000 * 1000 / 1_000_000) = 1000 = min_fee
    expect(calculateOpeningFee(1_000_000n, params)).toBe(1000n)
  })
})

describe('selectCheapestParams', () => {
  it('returns the first valid entry (menu is sorted by cost)', () => {
    const menu = [
      makeParams({ minFeeMsat: 100n, proportional: 100 }),
      makeParams({ minFeeMsat: 1000n, proportional: 1000 }),
    ]
    const result = selectCheapestParams(menu, 500_000n)
    expect(result).toBe(menu[0])
  })

  it('skips entries where payment is below min', () => {
    const menu = [
      makeParams({ minPaymentSizeMsat: 1_000_000n, minFeeMsat: 100n }),
      makeParams({ minPaymentSizeMsat: 1_000n, minFeeMsat: 100n }),
    ]
    const result = selectCheapestParams(menu, 500_000n)
    expect(result).toBe(menu[1])
  })

  it('skips entries where payment is above max', () => {
    const menu = [
      makeParams({ maxPaymentSizeMsat: 100_000n, minFeeMsat: 100n }),
      makeParams({ maxPaymentSizeMsat: 1_000_000_000n, minFeeMsat: 100n }),
    ]
    const result = selectCheapestParams(menu, 500_000n)
    expect(result).toBe(menu[1])
  })

  it('skips entries where fee >= payment', () => {
    const menu = [
      makeParams({ minFeeMsat: 500_000n }), // fee >= payment
      makeParams({ minFeeMsat: 100n }),
    ]
    const result = selectCheapestParams(menu, 500_000n)
    expect(result).toBe(menu[1])
  })

  it('returns null when no params are valid', () => {
    const menu = [makeParams({ minPaymentSizeMsat: 1_000_000_000n })]
    expect(selectCheapestParams(menu, 100n)).toBeNull()
  })
})

describe('deserializeOpeningFeeParams', () => {
  it('parses u64 fields from strings to bigint', () => {
    const result = deserializeOpeningFeeParams({
      min_fee_msat: '546000',
      proportional: 1200,
      valid_until: '2030-01-01T00:00:00.000Z',
      min_lifetime: 1008,
      max_client_to_self_delay: 2016,
      min_payment_size_msat: '10000',
      max_payment_size_msat: '1000000000',
      promise: 'abc',
    })
    expect(result.minFeeMsat).toBe(546_000n)
    expect(result.minPaymentSizeMsat).toBe(10_000n)
    expect(result.maxPaymentSizeMsat).toBe(1_000_000_000n)
    expect(result.proportional).toBe(1200)
  })

  it('rejects unrecognized fields', () => {
    expect(() =>
      deserializeOpeningFeeParams({
        min_fee_msat: '546000',
        proportional: 1200,
        valid_until: '2030-01-01T00:00:00.000Z',
        min_lifetime: 1008,
        max_client_to_self_delay: 2016,
        min_payment_size_msat: '10000',
        max_payment_size_msat: '1000000000',
        promise: 'abc',
        unknown_field: 'danger',
      })
    ).toThrow('Unrecognized field')
  })
})

describe('serializeOpeningFeeParams', () => {
  it('round-trips with deserialization', () => {
    const params = makeParams()
    const raw = serializeOpeningFeeParams(params)
    const restored = deserializeOpeningFeeParams(raw)
    expect(restored.minFeeMsat).toBe(params.minFeeMsat)
    expect(restored.proportional).toBe(params.proportional)
    expect(restored.promise).toBe(params.promise)
  })
})

describe('JSON-RPC serialization', () => {
  it('serializes a request', () => {
    const json = serializeJsonRpcRequest('abc', 'lsps2.get_info', { token: 'tok' })
    const parsed = JSON.parse(json) as {
      jsonrpc: string
      id: string
      method: string
      params: { token: string }
    }
    expect(parsed.jsonrpc).toBe('2.0')
    expect(parsed.id).toBe('abc')
    expect(parsed.method).toBe('lsps2.get_info')
    expect(parsed.params.token).toBe('tok')
  })

  it('deserializes a valid response', () => {
    const response = deserializeJsonRpcResponse(
      '{"jsonrpc":"2.0","id":"abc","result":{"opening_fee_params_menu":[]}}'
    )
    expect(response.id).toBe('abc')
    expect(response.result).toBeDefined()
  })

  it('rejects invalid JSON-RPC version', () => {
    expect(() => deserializeJsonRpcResponse('{"jsonrpc":"1.0","id":"abc"}')).toThrow('version')
  })
})

describe('lsps2ErrorMessage', () => {
  it('maps known codes to messages', () => {
    expect(lsps2ErrorMessage(201)).toContain('expired')
    expect(lsps2ErrorMessage(202)).toContain('small')
    expect(lsps2ErrorMessage(203)).toContain('large')
    expect(lsps2ErrorMessage(1)).toContain('rejected')
  })

  it('returns generic message for unknown codes', () => {
    expect(lsps2ErrorMessage(999)).toContain('999')
  })
})
