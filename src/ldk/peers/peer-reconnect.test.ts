import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PeerManager, ChannelManager } from 'lightningdevkit'
import { reconnectDisconnectedPeers } from './peer-reconnect'
import { hexToBytes } from '../utils'
import type { PeerConnection } from './peer-connection'

const LSP_ID = '02'.padEnd(66, '0')
const OTHER_ID = '03'.padEnd(66, '1')

vi.mock('../config', () => ({
  LDK_CONFIG: {
    lspNodeId: '02'.padEnd(66, '0'),
    lspHost: 'lsp.config.example',
    lspPort: 9735,
  },
}))

const getKnownPeers = vi.fn()
vi.mock('../storage/known-peers', () => ({
  getKnownPeers: (): unknown => getKnownPeers(),
}))

const connectToPeer = vi.fn()
vi.mock('./peer-connection', () => ({
  connectToPeer: (...args: unknown[]): unknown => connectToPeer(...args),
}))

const captureError = vi.fn()
vi.mock('../../storage/error-log', () => ({
  captureError: (...args: unknown[]): void => {
    captureError(...args)
  },
}))

function makeChannelManager(counterpartyHexIds: string[]): ChannelManager {
  return {
    list_channels: () =>
      counterpartyHexIds.map((hex) => ({
        get_counterparty: () => ({ get_node_id: () => hexToBytes(hex) }),
      })),
  } as unknown as ChannelManager
}

/** PeerManager with no connected peers — every channel peer is "disconnected". */
const EMPTY_PEER_MANAGER = { list_peers: () => [] } as unknown as PeerManager

describe('reconnectDisconnectedPeers — configured-LSP fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connectToPeer.mockResolvedValue({ disconnect: vi.fn() })
  })

  it('reconnects the configured LSP from config when it is not in known-peers', async () => {
    // Regression: the LSP connects at startup / via the JIT flow without
    // being persisted, so a dropped LSP channel peer was silently filtered
    // out and never reconnected.
    getKnownPeers.mockResolvedValue(new Map())

    const result = await reconnectDisconnectedPeers(
      makeChannelManager([LSP_ID]),
      EMPTY_PEER_MANAGER,
      new Map<string, PeerConnection>()
    )

    expect(connectToPeer).toHaveBeenCalledTimes(1)
    expect(connectToPeer.mock.calls[0]!.slice(1, 4)).toEqual([LSP_ID, 'lsp.config.example', 9735])
    expect(result).toEqual({ succeeded: 1, failed: 0 })
    expect(captureError).not.toHaveBeenCalled()
  })

  it('prefers the persisted known-peers address over config for the LSP', async () => {
    getKnownPeers.mockResolvedValue(new Map([[LSP_ID, { host: 'stored.example', port: 10735 }]]))

    await reconnectDisconnectedPeers(
      makeChannelManager([LSP_ID]),
      EMPTY_PEER_MANAGER,
      new Map<string, PeerConnection>()
    )

    expect(connectToPeer.mock.calls[0]!.slice(1, 4)).toEqual([LSP_ID, 'stored.example', 10735])
  })

  it('warns (instead of staying silent) for a disconnected channel peer with no address', async () => {
    getKnownPeers.mockResolvedValue(new Map())

    const result = await reconnectDisconnectedPeers(
      makeChannelManager([OTHER_ID]),
      EMPTY_PEER_MANAGER,
      new Map<string, PeerConnection>()
    )

    expect(connectToPeer).not.toHaveBeenCalled()
    expect(result).toEqual({ succeeded: 0, failed: 0 })
    expect(captureError).toHaveBeenCalledWith(
      'warning',
      'LDK',
      expect.stringContaining('No known address for disconnected channel peer')
    )
  })
})
