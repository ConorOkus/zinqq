import { describe, expect, it, vi } from 'vitest'
import type { LdkNode } from '../ldk/init'
import { startStableRuntime } from './runtime'
import { TRADE_TLV } from './protocol'
import type { StablePaymentEvent } from './types'

describe('stable runtime failed recovery', () => {
  it('keeps potentially financial events replayable if the backup cannot be restored', async () => {
    let callback: ((event: StablePaymentEvent) => void | Promise<void>) | undefined
    const runtime = await startStableRuntime({
      node: {} as LdkNode,
      vss: { getObject: () => Promise.reject(new Error('Backup offline')) } as never,
      alive: () => true,
      healthy: () => false,
      setPaymentCallback: (next) => {
        callback = next
      },
      quoteFunding: vi.fn(),
      confirmFunding: vi.fn(),
    })
    expect(runtime).toBeNull()
    expect(callback).toBeTypeOf('function')
    await expect(callback!({ kind: 'sent', paymentId: '1'.repeat(64) })).rejects.toThrow(
      /recovery failed/
    )
    await expect(
      callback!({
        kind: 'received',
        paymentId: '2'.repeat(64),
        amountMsat: 1n,
        channelIds: [],
        records: [{ type: TRADE_TLV, value: new Uint8Array() }],
      })
    ).rejects.toThrow(/recovery failed/)
    expect(
      callback!({
        kind: 'received',
        paymentId: '3'.repeat(64),
        amountMsat: 1000n,
        channelIds: [],
        records: [],
      })
    ).toBeUndefined()
  })
})
