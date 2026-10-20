import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LdkNode } from '../ldk/init'
import { configuredStableProvider, startStableRuntime } from './runtime'
import { TRADE_TLV } from './protocol'
import type { StablePaymentEvent } from './types'
import * as stableLdk from './ldk'
import { closeDb, clearAllStores, idbPut } from '../storage/idb'
import { initialStableState, STABLE_VSS_KEY } from './store'
import { getKnownPeers, putKnownPeer } from '../ldk/storage/known-peers'
import { reconnectDisconnectedPeers } from '../ldk/peers/peer-reconnect'
import * as peerConnection from '../ldk/peers/peer-connection'
import { hexToBytes } from '../ldk/utils'

vi.mock('../ldk/config', () => ({
  LDK_CONFIG: {
    lspNodeId: '02a02e2d83e37138a8de838f04acddc0a22463aea1092932c722b86e5c33080699',
    lspHost: '137.66.24.170',
    lspPort: 9735,
  },
}))

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

describe('stable provider reconnection after restore', () => {
  const provider = {
    nodeId: '0388948c5c7775a5eda3ee4a96434a270f20f5beeed7e9c99f242f21b87d658850',
    host: 'stablechannels.com',
    port: 9735,
  }

  it('saves the provider address when explicitly enabled, without saving an unselected provider', async () => {
    closeDb()
    await clearAllStores()
    vi.spyOn(stableLdk, 'providerChannel').mockReturnValue(null)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Price unavailable'))
    const selected = configuredStableProvider()
    const restored = await startStableRuntime({
      node: { trustedLspIds: new Set() } as LdkNode,
      vss: null,
      alive: () => true,
      healthy: () => false,
      setPaymentCallback: vi.fn(),
      quoteFunding: vi.fn(),
      confirmFunding: vi.fn(),
    })
    try {
      expect(restored).not.toBeNull()
      expect((await getKnownPeers()).has(selected.nodeId)).toBe(false)
      await restored!.enable()
      expect((await getKnownPeers()).get(selected.nodeId)).toEqual({
        host: selected.host,
        port: selected.port,
      })
      await restored!.client.refresh().catch(() => {})
    } finally {
      restored?.stop()
    }
  })

  it.each([
    { source: 'local', provider, known: null },
    { source: 'remote', provider, known: null },
    {
      source: 'custom remote',
      provider: { nodeId: '03' + 'b'.repeat(64), host: 'custom.example.com', port: 10735 },
      known: null,
    },
    {
      source: 'remote with a saved address',
      provider,
      known: { host: 'updated.example.com', port: 10735 },
    },
  ])(
    'reconnects the provider recovered from $source state when only the receive LSP is connected',
    async ({ source, provider, known }) => {
      closeDb()
      await clearAllStores()
      const state = { ...initialStableState(provider), enabled: true }
      if (source === 'local') await idbPut('ldk_stable_channels', 'primary', state)
      if (known) await putKnownPeer(provider.nodeId, known.host, known.port)
      const getObject = vi.fn((key: string) =>
        Promise.resolve(
          key === STABLE_VSS_KEY
            ? { value: new TextEncoder().encode(JSON.stringify(state)), version: 1 }
            : null
        )
      )
      const node = {
        trustedLspIds: new Set<string>(),
        channelManager: {
          list_channels: () => [
            { get_counterparty: () => ({ get_node_id: () => hexToBytes(provider.nodeId) }) },
          ],
        },
        peerManager: {
          list_peers: () => [
            {
              get_counterparty_node_id: () =>
                hexToBytes('02a02e2d83e37138a8de838f04acddc0a22463aea1092932c722b86e5c33080699'),
            },
          ],
        },
      } as unknown as LdkNode
      vi.spyOn(stableLdk, 'providerChannel').mockReturnValue({
        channelId: 'b'.repeat(64),
        userChannelId: '7',
        receiverSats: 100_000n,
        spendableSats: 100_000n,
        inboundSats: 200_000n,
        usable: false,
      })
      const connect = vi
        .spyOn(peerConnection, 'connectToPeer')
        .mockResolvedValue({ disconnect: vi.fn() })
      const restored = await startStableRuntime({
        node,
        vss: source === 'local' ? null : ({ getObject } as never),
        alive: () => true,
        healthy: () => false,
        setPaymentCallback: vi.fn(),
        quoteFunding: vi.fn(),
        confirmFunding: vi.fn(),
      })
      try {
        expect(restored).not.toBeNull()
        expect(restored!.client.getSnapshot().status).toBe('Provider channel is offline')
        const result = await reconnectDisconnectedPeers(
          node.channelManager,
          node.peerManager,
          new Map()
        )
        expect(connect).toHaveBeenCalledWith(
          node.peerManager,
          provider.nodeId,
          known?.host ?? provider.host,
          known?.port ?? provider.port,
          undefined
        )
        expect(result).toEqual({ succeeded: 1, failed: 0 })
        expect((await getKnownPeers()).get(provider.nodeId)).toEqual({
          host: known?.host ?? provider.host,
          port: known?.port ?? provider.port,
        })
      } finally {
        restored?.stop()
      }
    }
  )
})
