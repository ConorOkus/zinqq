import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { VssClient } from './storage/vss-client'

// Mock IDB
vi.mock('../storage/idb', () => ({
  idbGet: vi.fn().mockResolvedValue(undefined),
  idbGetAll: vi.fn().mockResolvedValue(new Map()),
  idbPut: vi.fn().mockResolvedValue(undefined),
  idbDelete: vi.fn().mockResolvedValue(undefined),
  idbDeleteBatch: vi.fn().mockResolvedValue(undefined),
}))

// Mock known-peers module
vi.mock('./storage/known-peers', async (importOriginal) => {
  return {
    ...(await importOriginal()),
    setKnownPeersVssClient: vi.fn(),
    getKnownPeers: vi.fn().mockResolvedValue(new Map()),
  }
})

// Mock config to avoid lightningdevkit Network import
vi.mock('./config', () => ({
  LDK_CONFIG: {
    network: 0,
    esploraUrl: 'https://example.com/api',
    chainPollIntervalMs: 30_000,
    wsProxyUrl: 'wss://example.com',
    peerTimerIntervalMs: 10_000,
    rgsUrl: 'https://example.com/snapshot',
    rgsSyncIntervalTicks: 60,
    vssUrl: 'https://example.com/vss',
    lspNodeId: '',
    lspHost: '',
    lspPort: 9735,
    lspToken: undefined,
    genesisBlockHash: '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6',
  },
  ACTIVE_NETWORK: 'signet',
}))

// Mock all heavy LDK dependencies
vi.mock('./storage/seed', () => ({
  getSeed: vi.fn().mockResolvedValue(null),
  storeDerivedSeed: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./traits/logger', () => ({
  createLogger: vi.fn(() => ({})),
}))
vi.mock('./traits/fee-estimator', () => ({
  createFeeEstimator: vi.fn(() => ({})),
}))
vi.mock('./traits/broadcaster', () => ({
  createBroadcaster: vi.fn(() => ({})),
  drainPendingBroadcasts: vi.fn(() => Promise.resolve()),
}))
vi.mock('./traits/filter', () => ({
  createFilter: vi.fn(() => ({
    filter: {},
    watchState: { txids: new Map(), outpoints: new Map() },
  })),
}))
vi.mock('./lsps2/node-secret', () => ({
  deriveNodeSecret: vi.fn(() => new Uint8Array(32)),
}))
vi.mock('@noble/secp256k1', () => ({
  getPublicKey: vi.fn(() => new Uint8Array(33)),
}))
vi.mock('./lsps2/message-handler', () => ({
  createLspsMessageHandler: vi.fn(() => ({
    handler: { as_CustomMessageHandler: () => ({}) },
    sendRequest: vi.fn(),
    destroy: vi.fn(),
    setFlushCallback: vi.fn(),
  })),
}))
vi.mock('./lsps2/client', () => ({
  LSPS2Client: class {
    constructor() {}
  },
}))
vi.mock('./traits/event-handler', () => ({
  createEventHandler: vi.fn(() => ({
    handler: {},
    cleanup: vi.fn(),
  })),
}))
vi.mock('./traits/bdk-signer-provider', () => ({
  createBdkSignerProvider: vi.fn(() => ({
    signerProvider: {},
  })),
}))
vi.mock('../onchain/init', () => ({
  initializeBdkWalletEager: vi.fn().mockResolvedValue({
    wallet: {},
    esploraClient: {},
  }),
}))
vi.mock('../onchain/config', () => ({
  ONCHAIN_CONFIG: { network: 0 },
}))
vi.mock('./sync/esplora-client', () => ({
  EsploraClient: class {
    getTipHash = vi.fn().mockResolvedValue('00'.repeat(32))
    getBlockHeight = vi.fn().mockResolvedValue(0)
    getBlockHash = vi
      .fn()
      .mockResolvedValue('00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6')
  },
}))
vi.mock('./storage/persist-cm', () => ({}))

// Mock persist module
const mockVersionCache = new Map<string, number>()
vi.mock('./traits/persist', async (importOriginal) => {
  return {
    ...(await importOriginal()),
    createPersister: vi.fn(() => ({
      persist: {},
      setChainMonitor: vi.fn(),
      onPersistFailure: vi.fn(),
      backfillManifest: vi.fn(),
      versionCache: mockVersionCache,
    })),
  }
})

// vi.hoisted runs before vi.mock factories, so instanceof checks work
const {
  MockMonitorResult,
  MockCmResult,
  MockNgResult,
  MockScorerResult,
  MockNodeIdResult,
  mockChannelMonitor,
} = vi.hoisted(() => ({
  MockMonitorResult: class {},
  MockCmResult: class {},
  MockNgResult: class {},
  MockScorerResult: class {},
  MockNodeIdResult: class {},
  mockChannelMonitor: {
    get_funding_txo: () => ({ get_a: () => ({}) }),
  },
}))

vi.mock('lightningdevkit', () => ({
  initializeWasmWebFetch: vi.fn().mockResolvedValue(undefined),
  KeysManager: {
    constructor_new: vi.fn(() => ({
      as_EntropySource: () => ({
        get_secure_random_bytes: () => new Uint8Array(32),
      }),
      as_NodeSigner: () => ({
        get_node_id: () => {
          const r = new MockNodeIdResult()
          Object.assign(r, { is_ok: () => true, res: new Uint8Array(33) })
          return r
        },
      }),
    })),
  },
  Recipient: { LDKRecipient_Node: 0 },
  Result_PublicKeyNoneZ_OK: MockNodeIdResult,
  ChainMonitor: {
    constructor_new: vi.fn(() => ({
      as_Watch: () => ({ watch_channel: vi.fn() }),
      as_Confirm: () => ({}),
    })),
  },
  Option_FilterZ: { constructor_some: vi.fn((f: unknown) => f) },
  ChannelManager: {
    constructor_new: vi.fn(() => ({
      list_channels: () => [],
      as_ChannelMessageHandler: () => ({}),
      as_Confirm: () => ({}),
      as_NodeIdLookUp: () => ({}),
      as_OffersMessageHandler: () => ({}),
      as_AsyncPaymentsMessageHandler: () => ({}),
      as_DNSResolverMessageHandler: () => ({}),
    })),
  },
  UserConfig: {
    constructor_default: vi.fn(() => ({
      set_manually_accept_inbound_channels: vi.fn(),
      get_channel_handshake_config: vi.fn(() => ({
        set_negotiate_scid_privacy: vi.fn(),
        set_negotiate_anchors_zero_fee_htlc_tx: vi.fn(),
        set_max_inbound_htlc_value_in_flight_percent_of_channel: vi.fn(),
      })),
      get_channel_handshake_limits: vi.fn(() => ({
        set_trust_own_funding_0conf: vi.fn(),
      })),
      get_channel_config: vi.fn(() => ({
        set_accept_underpaying_htlcs: vi.fn(),
      })),
    })),
  },
  ChainParameters: { constructor_new: vi.fn(() => ({})) },
  BestBlock: { constructor_new: vi.fn(() => ({})) },
  NetworkGraph: {
    constructor_new: vi.fn(() => ({ as_ReadOnly: () => ({}) })),
    constructor_read: vi.fn(),
  },
  ProbabilisticScorer: {
    constructor_new: vi.fn(() => ({ as_Score: () => ({}) })),
    constructor_read: vi.fn(),
  },
  ProbabilisticScoringDecayParameters: { constructor_default: vi.fn(() => ({})) },
  ProbabilisticScoringFeeParameters: { constructor_default: vi.fn(() => ({})) },
  MultiThreadedLockableScore: {
    constructor_new: vi.fn(() => ({ as_LockableScore: () => ({}) })),
  },
  DefaultRouter: {
    constructor_new: vi.fn(() => ({ as_Router: () => ({}) })),
  },
  DefaultMessageRouter: {
    constructor_new: vi.fn(() => ({ as_MessageRouter: () => ({}) })),
  },
  OnionMessenger: { constructor_new: vi.fn(() => ({ as_OnionMessageHandler: () => ({}) })) },
  UtilMethods: {
    constructor_C2Tuple_ThirtyTwoBytesChannelMonitorZ_read: vi.fn(() => {
      const r = new MockMonitorResult()
      Object.assign(r, { is_ok: () => true, res: { get_b: () => mockChannelMonitor } })
      return r
    }),
    constructor_C2Tuple_ThirtyTwoBytesChannelManagerZ_read: vi.fn(() => {
      const r = new MockCmResult()
      Object.assign(r, {
        is_ok: () => true,
        res: {
          get_b: () => ({
            list_channels: () => [],
            as_ChannelMessageHandler: () => ({}),
            as_Confirm: () => ({}),
            as_NodeIdLookUp: () => ({}),
            as_OffersMessageHandler: () => ({}),
            as_AsyncPaymentsMessageHandler: () => ({}),
            as_DNSResolverMessageHandler: () => ({}),
          }),
        },
      })
      return r
    }),
  },
  Result_C2Tuple_ThirtyTwoBytesChannelMonitorZDecodeErrorZ_OK: MockMonitorResult,
  Result_C2Tuple_ThirtyTwoBytesChannelManagerZDecodeErrorZ_OK: MockCmResult,
  Result_NetworkGraphDecodeErrorZ_OK: MockNgResult,
  Result_ProbabilisticScorerDecodeErrorZ_OK: MockScorerResult,
  P2PGossipSync: { constructor_new: vi.fn(() => ({ as_RoutingMessageHandler: () => ({}) })) },
  Option_UtxoLookupZ: { constructor_none: vi.fn(() => ({})) },
  PeerManager: { constructor_new: vi.fn(() => ({})) },
  IgnoringMessageHandler: {
    constructor_new: vi.fn(() => ({
      as_CustomOnionMessageHandler: () => ({}),
      as_CustomMessageHandler: () => ({}),
    })),
  },
  CustomMessageHandler: {
    new_impl: vi.fn(() => ({
      as_CustomMessageHandler: () => ({}),
    })),
  },
  Result_NoneLightningErrorZ: { constructor_ok: vi.fn(() => ({})) },
  Result_NoneNoneZ: { constructor_ok: vi.fn(() => ({})) },
  Result_COption_TypeZDecodeErrorZ: { constructor_ok: vi.fn(() => ({})) },
  Option_TypeZ: { constructor_none: vi.fn(() => ({})), constructor_some: vi.fn((x: unknown) => x) },
  TwoTuple_PublicKeyTypeZ: { constructor_new: vi.fn(() => ({})) },
  Type: { new_impl: vi.fn(() => ({})) },
  NodeFeatures: {
    constructor_empty: vi.fn(() => ({
      set_optional_custom_bit: vi.fn(() => ({ is_ok: () => true })),
    })),
  },
  InitFeatures: {
    constructor_empty: vi.fn(() => ({
      set_optional_custom_bit: vi.fn(() => ({ is_ok: () => true })),
    })),
  },
}))

import { idbGet, idbGetAll, idbPut, idbDelete, idbDeleteBatch } from '../storage/idb'
import { setKnownPeersVssClient, getKnownPeers } from './storage/known-peers'
import { MONITOR_MANIFEST_KEY } from './traits/persist'
import { KNOWN_PEERS_VSS_KEY } from './storage/known-peers'

// Must mock navigator.locks before importing init
Object.defineProperty(globalThis, 'navigator', {
  value: {
    locks: {
      request: vi.fn((_name: string, _opts: unknown, cb: (lock: unknown) => Promise<void>) => {
        return cb({})
      }),
    },
  },
  writable: true,
})

let initModule: typeof import('./init')

function makeVssClient(overrides: Partial<VssClient> = {}): VssClient {
  return {
    putObject: vi.fn().mockResolvedValue(1),
    getObject: vi.fn().mockResolvedValue(null),
    putObjects: vi.fn().mockResolvedValue(undefined),
    deleteObject: vi.fn().mockResolvedValue(undefined),
    listKeyVersions: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as VssClient
}

const monitorKey1 = 'a'.repeat(64) + ':0'
const monitorKey2 = 'b'.repeat(64) + ':1'
const monitorData1 = new Uint8Array([10, 20, 30])
const monitorData2 = new Uint8Array([40, 50, 60])
const cmData = new Uint8Array(64).fill(0xff)
const peersJson = JSON.stringify({ abc123: { host: '127.0.0.1', port: 9735 } })

function makeManifest(keys: string[]): { value: Uint8Array; version: number } {
  return {
    value: new TextEncoder().encode(JSON.stringify(keys)),
    version: 3,
  }
}

describe('VSS recovery in initializeLdk', () => {
  beforeEach(async () => {
    vi.resetModules()
    mockVersionCache.clear()
    vi.mocked(idbGet).mockReset().mockResolvedValue(undefined)
    vi.mocked(idbGetAll).mockReset().mockResolvedValue(new Map())
    vi.mocked(idbPut).mockReset().mockResolvedValue(undefined)
    vi.mocked(idbDelete).mockReset().mockResolvedValue(undefined)
    vi.mocked(idbDeleteBatch).mockReset().mockResolvedValue(undefined)
    vi.mocked(setKnownPeersVssClient).mockReset()
    vi.mocked(getKnownPeers).mockReset().mockResolvedValue(new Map())

    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    initModule = await import('./init')
  })

  it('recovers monitors + CM + peers from VSS when IDB is empty', async () => {
    const vssClient = makeVssClient({
      getObject: vi.fn().mockImplementation((key: string) => {
        if (key === MONITOR_MANIFEST_KEY) return makeManifest([monitorKey1, monitorKey2])
        if (key === monitorKey1) return { value: monitorData1, version: 1 }
        if (key === monitorKey2) return { value: monitorData2, version: 2 }
        if (key === 'channel_manager') return { value: cmData, version: 5 }
        if (key === KNOWN_PEERS_VSS_KEY)
          return { value: new TextEncoder().encode(peersJson), version: 4 }
        return null
      }),
    })

    await initModule.initializeLdk({
      ldkSeed: new Uint8Array(32),
      bdkDescriptors: { external: 'ext', internal: 'int' },
      vssClient,
    })

    // Monitors written to IDB
    expect(idbPut).toHaveBeenCalledWith('ldk_channel_monitors', monitorKey1, monitorData1)
    expect(idbPut).toHaveBeenCalledWith('ldk_channel_monitors', monitorKey2, monitorData2)
    // CM written to IDB
    expect(idbPut).toHaveBeenCalledWith('ldk_channel_manager', 'primary', cmData)
    // Known peers written to IDB
    expect(idbPut).toHaveBeenCalledWith('ldk_known_peers', 'abc123', {
      host: '127.0.0.1',
      port: 9735,
    })
    // VSS client wired for known peers with recovered version
    expect(setKnownPeersVssClient).toHaveBeenCalledWith(vssClient, 4)
  })

  it('rolls back partial IDB writes when monitor fetch fails midway', async () => {
    const vssClient = makeVssClient({
      getObject: vi.fn().mockImplementation((key: string) => {
        if (key === MONITOR_MANIFEST_KEY) return makeManifest([monitorKey1, monitorKey2])
        if (key === monitorKey1) return { value: monitorData1, version: 1 }
        if (key === monitorKey2) return null // missing!
        return null
      }),
    })

    // Should not throw — recovery failure is non-fatal, falls through to fresh state
    await initModule.initializeLdk({
      ldkSeed: new Uint8Array(32),
      bdkDescriptors: { external: 'ext', internal: 'int' },
      vssClient,
    })

    // Monitor 1 was written, but then rolled back
    expect(idbDeleteBatch).toHaveBeenCalledWith('ldk_channel_monitors', [monitorKey1])
    // CM was never written so no CM rollback
  })

  it('rolls back monitors when ChannelManager is missing from VSS', async () => {
    const vssClient = makeVssClient({
      getObject: vi.fn().mockImplementation((key: string) => {
        if (key === MONITOR_MANIFEST_KEY) return makeManifest([monitorKey1])
        if (key === monitorKey1) return { value: monitorData1, version: 1 }
        if (key === 'channel_manager') return null // missing CM
        return null
      }),
    })

    await initModule.initializeLdk({
      ldkSeed: new Uint8Array(32),
      bdkDescriptors: { external: 'ext', internal: 'int' },
      vssClient,
    })

    // Monitor was written then rolled back
    expect(idbDeleteBatch).toHaveBeenCalledWith('ldk_channel_monitors', [monitorKey1])
  })

  it('falls through to fresh state when manifest not found in VSS', async () => {
    const vssClient = makeVssClient({
      getObject: vi.fn().mockResolvedValue(null), // no manifest, no data
    })

    await initModule.initializeLdk({
      ldkSeed: new Uint8Array(32),
      bdkDescriptors: { external: 'ext', internal: 'int' },
      vssClient,
    })

    // No monitors or CM written
    const idbPutCalls = vi.mocked(idbPut).mock.calls
    const monitorWrites = idbPutCalls.filter(([store]) => store === 'ldk_channel_monitors')
    const cmWrites = idbPutCalls.filter(([store]) => store === 'ldk_channel_manager')
    expect(monitorWrites).toHaveLength(0)
    expect(cmWrites).toHaveLength(0)
  })

  it('rolls back monitors and CM when CM is too small', async () => {
    const tinyData = new Uint8Array(10) // < 32 bytes
    const vssClient = makeVssClient({
      getObject: vi.fn().mockImplementation((key: string) => {
        if (key === MONITOR_MANIFEST_KEY) return makeManifest([monitorKey1])
        if (key === monitorKey1) return { value: monitorData1, version: 1 }
        if (key === 'channel_manager') return { value: tinyData, version: 1 }
        return null
      }),
    })

    await initModule.initializeLdk({
      ldkSeed: new Uint8Array(32),
      bdkDescriptors: { external: 'ext', internal: 'int' },
      vssClient,
    })

    // Monitor rolled back
    expect(idbDeleteBatch).toHaveBeenCalledWith('ldk_channel_monitors', [monitorKey1])
    // CM was not written (failed validation before idbPut)
  })
})

describe('VSS migration (backfill)', () => {
  beforeEach(async () => {
    vi.resetModules()
    mockVersionCache.clear()
    vi.mocked(idbGet).mockReset().mockResolvedValue(undefined)
    vi.mocked(idbGetAll).mockReset().mockResolvedValue(new Map())
    vi.mocked(idbPut).mockReset().mockResolvedValue(undefined)
    vi.mocked(idbDelete).mockReset().mockResolvedValue(undefined)
    vi.mocked(idbDeleteBatch).mockReset().mockResolvedValue(undefined)
    vi.mocked(setKnownPeersVssClient).mockReset()
    vi.mocked(getKnownPeers).mockReset().mockResolvedValue(new Map())

    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    initModule = await import('./init')
  })

  it('uploads existing IDB state to VSS when VSS is empty', async () => {
    // IDB has data
    const existingMonitors = new Map([
      [monitorKey1, monitorData1],
      [monitorKey2, monitorData2],
    ])
    vi.mocked(idbGetAll).mockResolvedValue(existingMonitors)
    vi.mocked(idbGet).mockImplementation((store: string) =>
      Promise.resolve(store === 'ldk_channel_manager' ? cmData : undefined)
    )

    const peerMap = new Map([['abc123', { host: '127.0.0.1', port: 9735 }]])
    vi.mocked(getKnownPeers).mockResolvedValue(peerMap)

    const vssClient = makeVssClient({
      listKeyVersions: vi.fn().mockResolvedValue([]), // VSS is empty
    })

    await initModule.initializeLdk({
      ldkSeed: new Uint8Array(32),
      bdkDescriptors: { external: 'ext', internal: 'int' },
      vssClient,
    })

    // putObjects called with CM, monitors, manifest, and known peers
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const putObjectsMock = vi.mocked(vssClient.putObjects)
    expect(putObjectsMock).toHaveBeenCalledTimes(1)
    const items = putObjectsMock.mock.calls[0]![0]
    const keys = items.map((i: { key: string }) => i.key)
    expect(keys).toContain('channel_manager')
    expect(keys).toContain(monitorKey1)
    expect(keys).toContain(monitorKey2)
    expect(keys).toContain(MONITOR_MANIFEST_KEY)
    expect(keys).toContain(KNOWN_PEERS_VSS_KEY)
    // Known peers version seeded
    expect(setKnownPeersVssClient).toHaveBeenCalledWith(vssClient, 1)
  })

  it('skips migration when VSS already has data', async () => {
    const existingMonitors = new Map([[monitorKey1, monitorData1]])
    vi.mocked(idbGetAll).mockResolvedValue(existingMonitors)
    vi.mocked(idbGet).mockImplementation((store: string) =>
      Promise.resolve(store === 'ldk_channel_manager' ? cmData : undefined)
    )

    const vssClient = makeVssClient({
      listKeyVersions: vi.fn().mockResolvedValue([{ key: 'obfuscated', version: 1 }]),
    })

    await initModule.initializeLdk({
      ldkSeed: new Uint8Array(32),
      bdkDescriptors: { external: 'ext', internal: 'int' },
      vssClient,
    })

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(vssClient.putObjects)).not.toHaveBeenCalled()
  })
})
