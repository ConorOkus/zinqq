import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LdkNode } from '../ldk/init'
import { startStableRuntime } from './runtime'
import { TRADE_TLV } from './protocol'
import type { StablePaymentEvent } from './types'
import * as stableLdk from './ldk'
import { closeDb, clearAllStores } from '../storage/idb'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('first receive automatic dollars runtime', () => {
  it('converts a claimed receipt on the runtime update without opening settings', async () => {
    closeDb()
    await clearAllStores()
    const channelId = 'b'.repeat(64)
    vi.spyOn(stableLdk, 'providerChannel').mockReturnValue({
      channelId,
      userChannelId: '7',
      receiverSats: 100_000n,
      spendableSats: 100_000n,
      inboundSats: 200_000n,
      usable: true,
    })
    vi.spyOn(stableLdk, 'hasPendingPayments').mockReturnValue(false)
    vi.spyOn(stableLdk, 'signStable').mockReturnValue('client-signature')
    const send = vi.spyOn(stableLdk, 'sendStableKeysend').mockResolvedValue()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          observedAt: Date.now(),
          observations: [
            { source: 'Bitstamp', price: 100_000 },
            { source: 'Kraken', price: 100_000 },
            { source: 'Coinbase', price: 100_000 },
          ],
        })
      )
    )
    let tick: (() => void) | undefined
    vi.spyOn(globalThis, 'setInterval').mockImplementation((callback) => {
      tick = callback as () => void
      return 0
    })
    let callback: ((event: StablePaymentEvent) => void | Promise<void>) | undefined
    const runtime = await startStableRuntime({
      node: { trustedLspIds: new Set() } as LdkNode,
      vss: null,
      alive: () => true,
      healthy: () => true,
      setPaymentCallback: (next) => {
        callback = next
      },
      quoteFunding: vi.fn(),
      confirmFunding: vi.fn(),
    })
    try {
      expect(runtime).not.toBeNull()
      await runtime!.client.prepareFirstReceive('a'.repeat(64))
      runtime!.client.markSynced()
      await callback!({
        kind: 'received',
        paymentId: 'a'.repeat(64),
        amountMsat: 100_000_000n,
        channelIds: [channelId],
        records: [],
      })
      tick!()
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
      expect(runtime!.client.getSnapshot().state?.pending?.kind).toBe('trade')
      expect(runtime!.client.getSnapshot().state?.position).toBeNull()
      tick!()
      await runtime!.client.processInbox()
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      runtime?.stop()
    }
  })
})

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
