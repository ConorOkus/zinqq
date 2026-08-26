import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LSPS2Client } from './client'
import type { JsonRpcResponse } from './types'

const LSP_ID = '02'.padEnd(66, '0')

const FEE_PARAMS = {
  min_fee_msat: '0',
  proportional: 0,
  valid_until: '2030-01-01T00:00:00.000Z',
  min_lifetime: 2016,
  max_client_to_self_delay: 1440,
  min_payment_size_msat: '1000000',
  max_payment_size_msat: '50000000',
  promise: 'promise-hex',
}

/** Captures the serialized wire payload alongside a canned response. */
function makeClient(result: Record<string, unknown>): {
  client: LSPS2Client
  payloads: string[]
} {
  const payloads: string[] = []
  const client = new LSPS2Client((_pubkey, payload): Promise<JsonRpcResponse> => {
    payloads.push(payload)
    return Promise.resolve({ jsonrpc: '2.0', id: 'x', result } as JsonRpcResponse)
  })
  return { client, payloads }
}

describe('LSPS2Client request logging', () => {
  let logs: string[]

  beforeEach(() => {
    logs = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('redacts the token on get_info instead of printing it', async () => {
    const { client } = makeClient({ opening_fee_params_menu: [FEE_PARAMS] })

    await client.requestOpeningParams(LSP_ID, 'secret-token')

    const sent = logs.find((l) => l.includes('lsps2.get_info'))
    expect(sent).toContain('[REDACTED]')
    expect(sent).not.toContain('secret-token')
  })

  it('logs a null token on get_info when none is configured', async () => {
    const { client } = makeClient({ opening_fee_params_menu: [FEE_PARAMS] })

    await client.requestOpeningParams(LSP_ID, null)

    expect(logs.find((l) => l.includes('lsps2.get_info'))).toContain('"token":null')
  })

  it('does not fabricate a token field on buy, which takes none per spec', async () => {
    // Regression: the log line added `token` unconditionally, so buy printed
    // `"token":null` and read as if a configured token had been dropped on the
    // second leg of the flow — actively misleading when debugging a
    // token-gated LSP.
    const { client, payloads } = makeClient({
      jit_channel_scid: '1x2x3',
      lsp_cltv_expiry_delta: 144,
    })

    await client.selectOpeningParams(LSP_ID, 50_000_000n, {
      minFeeMsat: 0n,
      proportional: 0,
      validUntil: '2030-01-01T00:00:00.000Z',
      minLifetime: 2016,
      maxClientToSelfDelay: 1440,
      minPaymentSizeMsat: 1_000_000n,
      maxPaymentSizeMsat: 50_000_000n,
      promise: 'promise-hex',
    })

    const sent = logs.find((l) => l.includes('lsps2.buy'))
    expect(sent).not.toContain('token')
    // and the wire request genuinely carries no token either
    expect(payloads.some((p) => p.includes('lsps2.buy'))).toBe(true)
    expect(payloads.find((p) => p.includes('lsps2.buy'))).not.toContain('token')
  })
})
