import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StableClient, type StableClientDeps } from './client'
import { initialStableState } from './store'
import { SETTLEMENT_TLV, TRADE_TLV } from './protocol'
import type { StableState } from './types'

describe('stable client financial lifecycle', () => {
  const provider = { nodeId: '02' + '7'.repeat(64), host: 'stablechannels.com', port: 9735 }
  const channelId = '1'.repeat(64)
  let now: number
  let price: bigint
  let receiver: bigint
  let healthy: boolean
  let state: StableState
  let deps: StableClientDeps
  let client: StableClient
  const wire = (value: unknown) =>
    new TextEncoder().encode(
      JSON.stringify({ payload: JSON.stringify(value), signature: 'provider-signature' })
    )
  beforeEach(async () => {
    now = 1_000_000
    price = 10_000_000n
    receiver = 200_000n
    healthy = true
    state = initialStableState(provider)
    deps = {
      provider,
      now: () => now,
      store: {
        get state() {
          return state
        },
        save: vi.fn((next: StableState) => {
          state = next
          return Promise.resolve()
        }),
        flush: () => Promise.resolve(),
      },
      channel: () => ({
        channelId,
        userChannelId: '7',
        receiverSats: receiver,
        spendableSats: receiver,
        inboundSats: 200_000n,
        usable: true,
      }),
      canSend: () => healthy,
      sign: () => 'client-signature',
      verify: (_bytes, signature) => signature === 'provider-signature',
      send: vi.fn(() => Promise.resolve()),
      price: () =>
        Promise.resolve({
          priceCents: price,
          sources: ['Bitstamp', 'Kraken', 'Coinbase'],
          observedAt: now,
        }),
    }
    client = new StableClient(deps)
    await client.enable()
    await client.refresh()
    client.markSynced()
  })
  async function acceptedTrade() {
    await client.commit(client.quote(10_000n))
    const pending = state.pending!
    await client.onPayment({
      kind: 'received',
      paymentId: 'a'.repeat(64),
      amountMsat: 1n,
      channelIds: [channelId],
      records: [
        {
          type: TRADE_TLV,
          value: wire({
            type: 'SYNC_V1',
            channel_id: channelId,
            expected_usd: 100,
            backing_sats: 999_999,
            sync_version: 1,
            trade_id: pending.correlation!.tradeId,
            trade_payment_id: pending.paymentId,
            request_hash: pending.correlation!.requestHash,
          }),
        },
      ],
    })
    await client.processInbox()
  }
  it('persists intent before sending, and success alone does not establish USD', async () => {
    vi.mocked(deps.send).mockImplementation((intent) => {
      expect(state.pending?.paymentId).toBe(intent.paymentId)
      expect(state.position).toBeNull()
      return Promise.resolve()
    })
    await client.commit(client.quote(10_000n))
    await client.onPayment({ kind: 'sent', paymentId: state.pending!.paymentId })
    expect(state.position).toBeNull()
    expect(state.pending?.sent).toBe(true)
  })
  it('accepts only the matching signed result and ignores peer allocation', async () => {
    await acceptedTrade()
    expect(state.pending).toBeNull()
    expect(state.position?.targetUsd).toBe(100)
    expect(state.position?.backingSats).toBe('100000')
  })
  it('does not reset backing until an outgoing settlement succeeds', async () => {
    await acceptedTrade()
    now += 120_000
    price = 11_000_000n
    client.markSynced()
    await client.refresh()
    await client.tick()
    expect(state.position?.backingSats).toBe('100000')
    expect(state.pending?.amountMsat).toBe('9090000')
    await client.onPayment({ kind: 'sent', paymentId: state.pending!.paymentId })
    expect(state.position?.backingSats).toBe('90910')
    await client.tick()
    expect(state.pending).toBeNull() // Cooldown prevents another send.
  })
  it('keeps backing after a failed settlement', async () => {
    await acceptedTrade()
    now += 120_000
    price = 11_000_000n
    client.markSynced()
    await client.refresh()
    await client.tick()
    await client.onPayment({ kind: 'failed', paymentId: state.pending!.paymentId })
    expect(state.position?.backingSats).toBe('100000')
  })
  it('authenticates incoming settlement, clamps overpayment and deduplicates replay', async () => {
    await acceptedTrade()
    price = 9_000_000n
    now += 10_000
    await client.refresh()
    const event = {
      kind: 'received' as const,
      paymentId: 'b'.repeat(64),
      amountMsat: 20_000_000n,
      channelIds: [channelId],
      records: [
        {
          type: SETTLEMENT_TLV,
          value: wire({
            type: 'STABILITY_PAYMENT_V1',
            channel_id: channelId,
            settlement_id: 'c'.repeat(64),
            amount_msat: 20_000_000,
            direction: 'lsp_to_user',
            expected_usd: 100,
            created_at: Math.floor(now / 1000),
            expires_at: Math.floor(now / 1000) + 120,
          }),
        },
      ],
    }
    await client.onPayment(event)
    await client.processInbox()
    expect(state.position?.backingSats).toBe('111111')
    const revision = state.revision
    await client.onPayment(event)
    await client.processInbox()
    expect(state.revision).toBe(revision)
    await client.onPayment({ ...event, paymentId: 'd'.repeat(64) })
    await client.processInbox()
    expect(state.position?.backingSats).toBe('111111') // Same settlement id, different carrier.
  })
  it('rejects wrong-channel and wrong-signature messages', async () => {
    await client.commit(client.quote(10_000n))
    const pending = state.pending!
    const value = wire({
      type: 'SYNC_V1',
      channel_id: channelId,
      expected_usd: 100,
      backing_sats: 100000,
      sync_version: 1,
      trade_id: pending.correlation!.tradeId,
      trade_payment_id: pending.paymentId,
      request_hash: pending.correlation!.requestHash,
    })
    await client.onPayment({
      kind: 'received',
      paymentId: 'e'.repeat(64),
      amountMsat: 1n,
      channelIds: ['9'.repeat(64)],
      records: [{ type: TRADE_TLV, value }],
    })
    deps.verify = () => false
    await client.onPayment({
      kind: 'received',
      paymentId: 'f'.repeat(64),
      amountMsat: 1n,
      channelIds: [channelId],
      records: [{ type: TRADE_TLV, value }],
    })
    expect(state.position).toBeNull()
  })
  it.each([
    { direction: 'user_to_lsp' },
    { amount_msat: 19_000_000 },
    { expected_usd: 101 },
    { created_at: 0, expires_at: 900 },
    { created_at: 1061, expires_at: 1180 },
  ])('does not credit an invalid received settlement: %o', async (overrides) => {
    await acceptedTrade()
    price = 9_000_000n
    await client.refresh()
    await client.onPayment({
      kind: 'received',
      paymentId: 'b'.repeat(64),
      amountMsat: 20_000_000n,
      channelIds: [channelId],
      records: [
        {
          type: SETTLEMENT_TLV,
          value: wire({
            type: 'STABILITY_PAYMENT_V1',
            channel_id: channelId,
            settlement_id: 'c'.repeat(64),
            amount_msat: 20_000_000,
            direction: 'lsp_to_user',
            expected_usd: 100,
            created_at: 1000,
            expires_at: 1120,
            ...overrides,
          }),
        },
      ],
    })
    await client.processInbox()
    expect(state.position?.backingSats).toBe('100000')
  })
  it('ignores stale sync versions and unrequested correlated allocations', async () => {
    await acceptedTrade()
    const position = state.position
    for (const fields of [
      { sync_version: 1 },
      {
        sync_version: 2,
        trade_id: 'c'.repeat(64),
        trade_payment_id: 'd'.repeat(64),
        request_hash: 'e'.repeat(64),
      },
    ]) {
      await client.onPayment({
        kind: 'received',
        paymentId: 'b'.repeat(64),
        amountMsat: 1n,
        channelIds: [channelId],
        records: [
          {
            type: TRADE_TLV,
            value: wire({
              type: 'SYNC_V1',
              channel_id: channelId,
              expected_usd: 100,
              backing_sats: 999999,
              ...fields,
            }),
          },
        ],
      })
      await client.processInbox()
      expect(state.position).toEqual(position)
    }
  })
  it('applies a correlated signed rejection without creating a USD position', async () => {
    await client.commit(client.quote(10_000n))
    const pending = state.pending!
    await client.onPayment({
      kind: 'received',
      paymentId: 'b'.repeat(64),
      amountMsat: 1n,
      channelIds: [channelId],
      records: [
        {
          type: TRADE_TLV,
          value: wire({
            type: 'TRADE_REJECTED_V1',
            channel_id: channelId,
            trade_id: pending.correlation!.tradeId,
            trade_payment_id: pending.paymentId,
            request_hash: pending.correlation!.requestHash,
            reason_code: 'invalid_fee',
            decided_at: 1000,
          }),
        },
      ],
    })
    await client.processInbox()
    expect(state.pending).toBeNull()
    expect(state.position).toBeNull()
    expect(state.notice).toContain('invalid fee')
  })
  it('does not blindly retry a prepared intent after restart', async () => {
    await client.commit(client.quote(10_000n))
    client.stop()
    client = new StableClient(deps)
    client.markSynced()
    await client.refresh()
    await client.tick()
    expect(deps.send).toHaveBeenCalledTimes(1)
    expect(() => client.quote(20_000n)).toThrow(/previous/)
  })
  it('blocks stale-chain, unhealthy-wallet and expired-quote sends', async () => {
    now += 120_001
    expect(() => client.quote(10_000n)).toThrow(/sync/)
    client.markSynced()
    expect(() => client.quote(10_000n)).toThrow(/consensus/)
    await client.refresh()
    healthy = false
    expect(() => client.quote(10_000n)).toThrow(/active/)
    expect(deps.send).not.toHaveBeenCalled()
  })
  it('sends nothing if the intent cannot be made durable', async () => {
    vi.mocked(deps.store.save).mockRejectedValueOnce(new Error('backup offline'))
    await expect(client.commit(client.quote(10_000n))).rejects.toThrow(/backup/)
    expect(deps.send).not.toHaveBeenCalled()
  })
  it('blocks ordinary sends while the remote intent write is still in flight', async () => {
    let release!: () => void
    vi.mocked(deps.store.save).mockImplementationOnce(async (next) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      state = next
    })
    const committing = client.commit(client.quote(10_000n))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(state.pending).toBeNull()
    expect(client.blocksOrdinaryPayments()).toBe(true)
    release()
    await committing
    expect(client.blocksOrdinaryPayments()).toBe(true)
  })
  it('invalidates a quote when financial state changes', async () => {
    const quote = client.quote(10_000n)
    await client.enable()
    await expect(client.commit(quote)).rejects.toThrow(/changed/)
    expect(deps.send).not.toHaveBeenCalled()
  })
  it('durably accepts a receipt during an oracle outage without holding up LDK events', async () => {
    await acceptedTrade()
    now += 61_000
    const event = {
      kind: 'received' as const,
      paymentId: 'b'.repeat(64),
      amountMsat: 20_000_000n,
      channelIds: [channelId],
      records: [
        {
          type: SETTLEMENT_TLV,
          value: wire({
            type: 'STABILITY_PAYMENT_V1',
            channel_id: channelId,
            settlement_id: 'c'.repeat(64),
            amount_msat: 20_000_000,
            direction: 'lsp_to_user',
            expected_usd: 100,
            created_at: Math.floor(now / 1000),
            expires_at: Math.floor(now / 1000) + 120,
          }),
        },
      ],
    }
    await expect(client.onPayment(event)).resolves.toBeUndefined()
    expect(state.inbox).toHaveLength(1)
    await expect(client.processInbox()).rejects.toThrow(/consensus/)
    expect(state.position?.backingSats).toBe('100000')
    price = 9_000_000n
    await client.refresh()
    await client.processInbox()
    expect(state.inbox).toHaveLength(0)
    expect(state.position?.backingSats).toBe('111111')
  })
  it('queues incoming settlement until an outgoing settlement reaches its terminal outcome', async () => {
    await acceptedTrade()
    now += 120_000
    price = 11_000_000n
    client.markSynced()
    await client.refresh()
    await client.tick()
    const outgoingId = state.pending!.paymentId
    now += 1_000
    price = 9_000_000n
    await client.refresh()
    await client.onPayment({
      kind: 'received',
      paymentId: 'b'.repeat(64),
      amountMsat: 20_000_000n,
      channelIds: [channelId],
      records: [
        {
          type: SETTLEMENT_TLV,
          value: wire({
            type: 'STABILITY_PAYMENT_V1',
            channel_id: channelId,
            settlement_id: 'c'.repeat(64),
            amount_msat: 20_000_000,
            direction: 'lsp_to_user',
            expected_usd: 100,
            created_at: Math.floor(now / 1000),
            expires_at: Math.floor(now / 1000) + 120,
          }),
        },
      ],
    })
    await client.processInbox()
    expect(state.inbox).toHaveLength(1)
    expect(state.position?.backingSats).toBe('100000')
    await client.onPayment({ kind: 'sent', paymentId: outgoingId })
    await client.processInbox()
    expect(state.position?.backingSats).toBe('110910')
    expect(state.inbox).toHaveLength(0)
  })
  it('refuses a provider reduction without a corresponding spend of backing', async () => {
    await acceptedTrade()
    await client.onPayment({
      kind: 'received',
      paymentId: 'b'.repeat(64),
      amountMsat: 1n,
      channelIds: [channelId],
      records: [
        {
          type: TRADE_TLV,
          value: wire({
            type: 'SYNC_V1',
            channel_id: channelId,
            expected_usd: 0,
            backing_sats: 0,
            sync_version: 2,
          }),
        },
      ],
    })
    await client.processInbox()
    expect(state.position?.targetUsd).toBe(100)
    expect(state.position?.backingSats).toBe('100000')
  })
  it('reconciles a genuine ordinary spend that consumed stable backing', async () => {
    await acceptedTrade()
    receiver = 80_000n
    await client.onPayment({
      kind: 'received',
      paymentId: 'b'.repeat(64),
      amountMsat: 1n,
      channelIds: [channelId],
      records: [
        {
          type: TRADE_TLV,
          value: wire({
            type: 'SYNC_V1',
            channel_id: channelId,
            expected_usd: 80,
            backing_sats: 999999,
            sync_version: 2,
          }),
        },
      ],
    })
    await client.processInbox()
    expect(state.position?.targetUsd).toBe(80)
    expect(state.position?.backingSats).toBe('80000')
  })
  it('uses actual remaining backing when market rounding differs during spend reconciliation', async () => {
    await acceptedTrade()
    receiver = 80_000n
    price = 10_001_000n
    await client.refresh()
    await client.onPayment({
      kind: 'received',
      paymentId: 'b'.repeat(64),
      amountMsat: 1n,
      channelIds: [channelId],
      records: [
        {
          type: TRADE_TLV,
          value: wire({
            type: 'SYNC_V1',
            channel_id: channelId,
            expected_usd: 80,
            backing_sats: 999999,
            sync_version: 2,
          }),
        },
      ],
    })
    await client.processInbox()
    expect(state.inbox).toHaveLength(0)
    expect(state.position?.targetUsd).toBe(80)
    expect(state.position?.backingSats).toBe('80000')
  })
  it('clears a closed position explicitly so a new provider channel can be used', async () => {
    await acceptedTrade()
    await expect(client.clearClosedPosition()).rejects.toThrow(/Close/)
    deps.channel = () => null
    client.refreshStatus()
    expect(client.getSnapshot().status).toBe('Previous stable channel is closed')
    await client.clearClosedPosition()
    expect(state.position).toBeNull()
  })
  it('preserves an unresolved payment even after its channel closes', async () => {
    await acceptedTrade()
    now += 120_000
    price = 11_000_000n
    client.markSynced()
    await client.refresh()
    await client.tick()
    deps.channel = () => null
    await expect(client.clearClosedPosition()).rejects.toThrow(/pending/)
    expect(state.pending).not.toBeNull()
  })
})
