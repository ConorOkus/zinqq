import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockClaimFunds = vi.fn()
const mockProcessPendingHtlcForwards = vi.fn()
const mockFundingTransactionGenerated = vi.fn((): { is_ok: () => boolean } => ({
  is_ok: () => true,
}))
const mockListChannels = vi.fn((): unknown[] => [])
const mockOnChannelClosed = vi.fn()

vi.mock('lightningdevkit', () => {
  class MockEvent {}
  class Event_PaymentClaimable extends MockEvent {
    payment_hash = new Uint8Array([1, 2, 3])
    amount_msat = BigInt(100000)
    via_channel_id = { write: () => new Uint8Array([7, 8]) }
    purpose = {
      preimage: () => new Option_ThirtyTwoBytesZ_Some(new Uint8Array([4, 5, 6])),
      constructor: { name: 'PaymentPurpose_Bolt11InvoicePayment' },
    }
  }
  class Event_PaymentClaimed extends MockEvent {
    payment_hash = new Uint8Array([1, 2, 3])
    amount_msat = BigInt(100000)
  }
  class Event_PaymentSent extends MockEvent {
    payment_hash = new Uint8Array([1, 2, 3])
    payment_id = new Option_ThirtyTwoBytesZ_Some(new Uint8Array([1, 2, 3]))
    payment_preimage = new Uint8Array([7, 8, 9])
    fee_paid_msat = new Option_u64Z_Some(BigInt(100))
  }
  class Event_PaymentFailed extends MockEvent {
    payment_id = new Uint8Array([1, 2, 3])
    payment_hash = new Option_ThirtyTwoBytesZ_Some(new Uint8Array([1, 2, 3]))
    reason = new Option_PaymentFailureReasonZ_Some(0) // RecipientRejected
  }
  class Event_PendingHTLCsForwardable extends MockEvent {
    time_forwardable = BigInt(2)
  }
  class Event_SpendableOutputs extends MockEvent {
    outputs = [{ write: () => new Uint8Array([10, 20, 30]) }]
  }
  class Event_ChannelPending extends MockEvent {
    channel_id = { write: () => new Uint8Array([7, 8]) }
    former_temporary_channel_id = { write: () => new Uint8Array([0xaa, 0xbb]) }
    counterparty_node_id = new Uint8Array([0xaa, 0xbb, 0xcc])
  }
  class Event_ChannelReady extends MockEvent {
    channel_id = { write: () => new Uint8Array([7, 8]) }
    counterparty_node_id = new Uint8Array([0xaa, 0xbb, 0xcc])
  }
  class ClosureReason_CounterpartyForceClosed {}
  class ClosureReason_HolderForceClosed {}
  class ClosureReason_LegacyCooperativeClosure {}
  class ClosureReason_CounterpartyInitiatedCooperativeClosure {}
  class ClosureReason_LocallyInitiatedCooperativeClosure {}
  class ClosureReason_CommitmentTxConfirmed {}
  class ClosureReason_FundingTimedOut {}
  class ClosureReason_ProcessingError {}
  class ClosureReason_DisconnectedPeer {}
  class ClosureReason_OutdatedChannelManager {}
  class ClosureReason_CounterpartyCoopClosedUnfundedChannel {}
  class ClosureReason_FundingBatchClosure {}
  class ClosureReason_HTLCsTimedOut {}
  class ClosureReason_PeerFeerateTooLow {}
  class Event_ChannelClosed extends MockEvent {
    channel_id = { write: () => new Uint8Array([7, 8]) }
    counterparty_node_id = new Uint8Array([0xaa, 0xbb, 0xcc])
    reason = new ClosureReason_LegacyCooperativeClosure()
  }
  class SocketAddress_TcpIpV4 {
    addr: Uint8Array
    port: number
    constructor(addr: Uint8Array, port: number) {
      this.addr = addr
      this.port = port
    }
  }
  class SocketAddress_TcpIpV6 {
    addr: Uint8Array
    port: number
    constructor(addr: Uint8Array, port: number) {
      this.addr = addr
      this.port = port
    }
  }
  class SocketAddress_Hostname {
    hostname: { to_str: () => string }
    port: number
    constructor(hostname: string, port: number) {
      this.hostname = { to_str: () => hostname }
      this.port = port
    }
  }
  class Event_ConnectionNeeded extends MockEvent {
    node_id = new Uint8Array([9, 10, 11])
    addresses: unknown[] = []
  }
  class Event_FundingGenerationReady extends MockEvent {
    temporary_channel_id = { write: () => new Uint8Array([0xaa, 0xbb]) }
    counterparty_node_id = new Uint8Array([0xcc, 0xdd])
    channel_value_satoshis = BigInt(100_000)
    output_script = new Uint8Array([0x00, 0x14, 0x01, 0x02])
  }
  class Event_FundingTxBroadcastSafe extends MockEvent {
    channel_id = { write: () => new Uint8Array([0xee, 0xff]) }
    former_temporary_channel_id = { write: () => new Uint8Array([0xaa, 0xbb]) }
    funding_txo = {}
    counterparty_node_id = new Uint8Array([0xcc, 0xdd])
    user_channel_id = BigInt(42)
  }
  class Event_BumpTransaction extends MockEvent {}
  class Event_PaymentPathSuccessful extends MockEvent {}
  class Event_PaymentPathFailed extends MockEvent {}
  class Event_OpenChannelRequest extends MockEvent {
    temporary_channel_id = { write: () => new Uint8Array([0xaa, 0xbb]) }
    counterparty_node_id = new Uint8Array(33).fill(0x02)
  }
  class Event_DiscardFunding extends MockEvent {
    channel_id = { write: () => new Uint8Array([0xee, 0xff]) }
    funding_info = {}
  }
  class Event_HTLCHandlingFailed extends MockEvent {
    prev_channel_id = { write: () => new Uint8Array([0xaa, 0xbb]) }
    failed_next_destination = { constructor: { name: 'TestDestination' } }
  }
  class PaymentPurpose_Bolt11InvoicePayment {}
  class PaymentPurpose_SpontaneousPayment {}

  class Option_ThirtyTwoBytesZ_Some {
    some: Uint8Array
    constructor(s: Uint8Array) {
      this.some = s
    }
  }

  class Option_ThirtyTwoBytesZ_None {}

  class Option_u64Z_Some {
    some: bigint
    constructor(s: bigint) {
      this.some = s
    }
  }

  class Option_PaymentFailureReasonZ_Some {
    some: number
    constructor(s: number) {
      this.some = s
    }
  }

  const PaymentFailureReason = {
    LDKPaymentFailureReason_RecipientRejected: 0,
    LDKPaymentFailureReason_UserAbandoned: 1,
    LDKPaymentFailureReason_RetriesExhausted: 2,
    LDKPaymentFailureReason_PaymentExpired: 3,
    LDKPaymentFailureReason_RouteNotFound: 4,
    LDKPaymentFailureReason_UnexpectedError: 5,
    LDKPaymentFailureReason_UnknownRequiredFeatures: 6,
    LDKPaymentFailureReason_InvoiceRequestExpired: 7,
    LDKPaymentFailureReason_InvoiceRequestRejected: 8,
    LDKPaymentFailureReason_BlindedPathCreationFailed: 9,
  }

  return {
    EventHandler: {
      new_impl: vi.fn((impl: { handle_event: (event: unknown) => unknown }) => ({
        _impl: impl,
      })),
    },
    Event_PaymentClaimable,
    Event_PaymentClaimed,
    Event_PaymentSent,
    Event_PaymentFailed,
    Event_PendingHTLCsForwardable,
    Event_SpendableOutputs,
    Event_ChannelPending,
    Event_ChannelReady,
    Event_ChannelClosed,
    Event_FundingGenerationReady,
    Event_FundingTxBroadcastSafe,
    Event_OpenChannelRequest,
    Event_ConnectionNeeded,
    Event_BumpTransaction,
    Event_PaymentPathSuccessful,
    Event_PaymentPathFailed,
    Event_DiscardFunding,
    Event_HTLCHandlingFailed,
    PaymentPurpose_Bolt11InvoicePayment,
    PaymentPurpose_SpontaneousPayment,
    Option_ThirtyTwoBytesZ_Some,
    Option_ThirtyTwoBytesZ_None,
    Option_u64Z_Some,
    Option_PaymentFailureReasonZ_Some,
    PaymentFailureReason,
    ClosureReason_CounterpartyForceClosed,
    ClosureReason_HolderForceClosed,
    ClosureReason_LegacyCooperativeClosure,
    ClosureReason_CounterpartyInitiatedCooperativeClosure,
    ClosureReason_LocallyInitiatedCooperativeClosure,
    ClosureReason_CommitmentTxConfirmed,
    ClosureReason_FundingTimedOut,
    ClosureReason_ProcessingError,
    ClosureReason_DisconnectedPeer,
    ClosureReason_OutdatedChannelManager,
    ClosureReason_CounterpartyCoopClosedUnfundedChannel,
    ClosureReason_FundingBatchClosure,
    ClosureReason_HTLCsTimedOut,
    ClosureReason_PeerFeerateTooLow,
    SocketAddress_TcpIpV4,
    SocketAddress_TcpIpV6,
    SocketAddress_Hostname,
    Result_NoneReplayEventZ: {
      constructor_ok: vi.fn(() => ({ is_ok: () => true })),
    },
    Result_NoneAPIErrorZ_Err: class {},
  }
})

const mockIdbGet = vi.fn((): Promise<string | undefined> => Promise.resolve(undefined))
vi.mock('../../storage/idb', () => ({
  idbPut: vi.fn(() => Promise.resolve()),
  idbGet: () => mockIdbGet(),
  idbDelete: vi.fn(() => Promise.resolve()),
  idbGetAll: vi.fn(() => Promise.resolve(new Map())),
}))

const mockBroadcastWithRetry = vi.fn((_url: string, _txHex: string) => Promise.resolve('txid123')) // eslint-disable-line @typescript-eslint/no-unused-vars
vi.mock('./broadcaster', () => ({
  broadcastWithRetry: (url: string, txHex: string) => mockBroadcastWithRetry(url, txHex),
}))

vi.mock('../../onchain/config', () => ({
  ONCHAIN_CONFIG: { esploraUrl: 'https://test.esplora/api' },
}))
vi.mock('../config', () => ({
  LDK_CONFIG: { esploraFallbackUrl: undefined },
}))

vi.mock('../../onchain/storage/changeset', () => ({
  putChangeset: vi.fn(() => Promise.resolve()),
}))

vi.mock('../sweep', () => ({
  sweepSpendableOutputs: vi.fn(() => Promise.resolve({ swept: 0, skipped: 0, txid: null })),
}))

const mockExtractedTxBytes = new Uint8Array([0xde, 0xad])
const mockPsbt = {
  extract_tx: () => ({ to_bytes: () => mockExtractedTxBytes }),
  toString: () => 'base64psbt',
}
const mockTxBuilder = {
  nlocktime: vi.fn(() => mockTxBuilder),
  add_recipient: vi.fn(() => mockTxBuilder),
  finish: vi.fn(() => mockPsbt),
}
const mockBdkWallet = {
  build_tx: vi.fn(() => mockTxBuilder),
  sign: vi.fn(),
  take_staged: vi.fn(() => ({ is_empty: () => true, to_json: () => '{}' })),
  next_unused_address: vi.fn(() => ({
    address: { script_pubkey: { as_bytes: () => new Uint8Array([0x00, 0x14]) } },
  })),
}
vi.mock('@bitcoindevkit/bdk-wallet-web', () => ({
  Wallet: class {},
  Recipient: class {
    constructor(_s: unknown, _a: unknown) {} // eslint-disable-line @typescript-eslint/no-unused-vars
  },
  ScriptBuf: { from_bytes: vi.fn((b: unknown) => b) },
  Amount: { from_sat: vi.fn((s: unknown) => s) },
  SignOptions: class {},
}))

vi.mock('../utils', () => ({
  bytesToHex: vi.fn((bytes: Uint8Array) =>
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  ),
}))

import { createEventHandler } from './event-handler'
import { idbPut } from '../../storage/idb'

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-argument */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ldk: any = await import('lightningdevkit')
const {
  Event_PaymentClaimable,
  Event_PaymentClaimed,
  Event_PaymentSent,
  Event_PaymentFailed,
  Event_PendingHTLCsForwardable,
  Event_SpendableOutputs,
  Event_ChannelPending,
  Event_ChannelReady,
  Event_ChannelClosed,
  Event_ConnectionNeeded,
  Event_FundingGenerationReady,
  Event_FundingTxBroadcastSafe,
  Event_BumpTransaction,
  Event_PaymentPathSuccessful,
  Event_PaymentPathFailed,
  Event_OpenChannelRequest,
  Event_DiscardFunding,
  Option_ThirtyTwoBytesZ_None,
  SocketAddress_TcpIpV4,
  SocketAddress_Hostname,
} = ldk

function createMockKeysManager() {
  return {
    as_OutputSpender: vi.fn(() => ({
      spend_spendable_outputs: vi.fn(() => ({ is_ok: () => false })),
    })),
  } as never
}

const mockAcceptInboundChannel = vi.fn((): { is_ok: () => boolean } => ({ is_ok: () => true }))
const mockAcceptInbound0conf = vi.fn((): { is_ok: () => boolean } => ({ is_ok: () => true }))

function createMockChannelManager() {
  return {
    claim_funds: mockClaimFunds,
    process_pending_htlc_forwards: mockProcessPendingHtlcForwards,
    funding_transaction_generated: mockFundingTransactionGenerated,
    list_channels: mockListChannels,
    accept_inbound_channel: mockAcceptInboundChannel,
    accept_inbound_channel_from_trusted_peer_0conf: mockAcceptInbound0conf,
  } as never
}

type HandleEventFn = (event: unknown) => unknown

describe('createEventHandler', () => {
  let handleEvent: HandleEventFn
  let cleanup: () => void
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()

    const cm = createMockChannelManager()
    const km = createMockKeysManager()
    const result = createEventHandler(
      cm,
      km,
      mockBdkWallet as never,
      '', // lspNodeId - empty for tests
      undefined,
      mockOnChannelClosed
    )
    cleanup = result.cleanup
    handleEvent = (result.handler as unknown as { _impl: { handle_event: HandleEventFn } })._impl
      .handle_event
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('claims payment on PaymentClaimable with preimage', () => {
    handleEvent(new Event_PaymentClaimable())
    expect(mockClaimFunds).toHaveBeenCalledWith(new Uint8Array([4, 5, 6]))
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('PaymentClaimable'),
      expect.stringContaining('paymentHash:'),
      expect.any(String),
      expect.stringContaining('amount_msat:'),
      expect.any(String),
      expect.stringContaining('purpose:'),
      expect.any(String)
    )
  })

  it('warns when PaymentClaimable has no preimage', () => {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
    const event = Object.assign(new Event_PaymentClaimable(), {
      purpose: {
        preimage: () => new Option_ThirtyTwoBytesZ_None(),
        constructor: { name: 'TestPurpose' },
      },
    })
    /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
    handleEvent(event)
    expect(mockClaimFunds).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no preimage'),
      expect.any(String),
      expect.stringContaining('purpose:'),
      expect.any(String),
      expect.stringContaining('cannot be claimed')
    )
  })

  it('logs PaymentClaimed', () => {
    handleEvent(new Event_PaymentClaimed())
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('PaymentClaimed'),
      expect.any(String),
      expect.any(String),
      expect.any(String)
    )
  })

  it('logs PaymentSent', () => {
    handleEvent(new Event_PaymentSent())
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('PaymentSent'), expect.any(String))
  })

  it('warns on PaymentFailed', () => {
    handleEvent(new Event_PaymentFailed())
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('PaymentFailed'),
      expect.any(String),
      expect.any(String)
    )
  })

  it('schedules HTLC forwarding with delay', () => {
    handleEvent(new Event_PendingHTLCsForwardable())
    expect(mockProcessPendingHtlcForwards).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2000)
    expect(mockProcessPendingHtlcForwards).toHaveBeenCalledOnce()
  })

  it('clamps HTLC forwarding delay to 10s max', () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const event = Object.assign(new Event_PendingHTLCsForwardable(), {
      time_forwardable: BigInt(999),
    })
    handleEvent(event)
    vi.advanceTimersByTime(9999)
    expect(mockProcessPendingHtlcForwards).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(mockProcessPendingHtlcForwards).toHaveBeenCalledOnce()
  })

  it('cleanup cancels pending HTLC forward timer', () => {
    handleEvent(new Event_PendingHTLCsForwardable())
    cleanup()
    vi.advanceTimersByTime(10000)
    expect(mockProcessPendingHtlcForwards).not.toHaveBeenCalled()
  })

  it('persists SpendableOutputs to IDB', () => {
    handleEvent(new Event_SpendableOutputs())
    expect(idbPut).toHaveBeenCalledWith('ldk_spendable_outputs', expect.any(String), [
      expect.any(Uint8Array),
    ])
  })

  it('logs "persisting" for SpendableOutputs', () => {
    handleEvent(new Event_SpendableOutputs())
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('persisting'),
      expect.any(Number),
      expect.any(String)
    )
  })

  it('logs ChannelPending', () => {
    handleEvent(new Event_ChannelPending())
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('ChannelPending'),
      expect.stringContaining('channelId:'),
      expect.any(String),
      expect.stringContaining('counterparty:'),
      expect.any(String)
    )
  })

  it('logs ChannelReady', () => {
    handleEvent(new Event_ChannelReady())
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('ChannelReady'),
      expect.stringContaining('channelId:'),
      expect.any(String),
      expect.stringContaining('counterparty:'),
      expect.any(String)
    )
  })

  it('logs ChannelClosed with reason', () => {
    handleEvent(new Event_ChannelClosed())
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('ChannelClosed'),
      expect.any(String),
      'reason:',
      'Cooperative close'
    )
  })

  it('calls onChannelClosed when last channel with peer closes', () => {
    mockListChannels.mockReturnValueOnce([])
    handleEvent(new Event_ChannelClosed())
    expect(mockOnChannelClosed).toHaveBeenCalledWith('aabbcc')
  })

  it('does not call onChannelClosed when peer still has channels', () => {
    mockListChannels.mockReturnValueOnce([
      { get_counterparty: () => ({ get_node_id: () => new Uint8Array([0xaa, 0xbb, 0xcc]) }) },
    ])
    handleEvent(new Event_ChannelClosed())
    expect(mockOnChannelClosed).not.toHaveBeenCalled()
  })

  it('calls onSyncNeeded when channel closes', () => {
    const mockSyncNeeded = vi.fn()
    const cm = createMockChannelManager()
    const result = createEventHandler(
      cm,
      createMockKeysManager(),
      mockBdkWallet as never,
      '',
      undefined,
      undefined,
      mockSyncNeeded
    )
    const handler = (result.handler as unknown as { _impl: { handle_event: HandleEventFn } })._impl
      .handle_event

    handler(new Event_ChannelClosed())
    expect(mockSyncNeeded).toHaveBeenCalledOnce()
    result.cleanup()
  })

  it('calls onConnectionNeeded with parsed TcpIpV4 address', () => {
    const mockConnectionNeeded = vi.fn()
    const cm = createMockChannelManager()
    const result = createEventHandler(
      cm,
      createMockKeysManager(),
      mockBdkWallet as never,
      '',
      undefined,
      undefined,
      undefined,
      mockConnectionNeeded
    )
    const handler = (result.handler as unknown as { _impl: { handle_event: HandleEventFn } })._impl
      .handle_event

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const event = Object.assign(new Event_ConnectionNeeded(), {
      addresses: [new SocketAddress_TcpIpV4(new Uint8Array([192, 168, 1, 100]), 9735)],
    })
    handler(event)
    expect(mockConnectionNeeded).toHaveBeenCalledWith('090a0b', '192.168.1.100', 9735)
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('ConnectionNeeded'),
      expect.any(String),
      expect.stringContaining('connecting to'),
      '192.168.1.100:9735'
    )
    result.cleanup()
  })

  it('calls onConnectionNeeded with parsed Hostname address', () => {
    const mockConnectionNeeded = vi.fn()
    const cm = createMockChannelManager()
    const result = createEventHandler(
      cm,
      createMockKeysManager(),
      mockBdkWallet as never,
      '',
      undefined,
      undefined,
      undefined,
      mockConnectionNeeded
    )
    const handler = (result.handler as unknown as { _impl: { handle_event: HandleEventFn } })._impl
      .handle_event

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const event = Object.assign(new Event_ConnectionNeeded(), {
      addresses: [new SocketAddress_Hostname('node.example.com', 9735)],
    })
    handler(event)
    expect(mockConnectionNeeded).toHaveBeenCalledWith('090a0b', 'node.example.com', 9735)
    result.cleanup()
  })

  it('warns on ConnectionNeeded with no usable addresses', () => {
    handleEvent(new Event_ConnectionNeeded())
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ConnectionNeeded'),
      expect.any(String),
      expect.stringContaining('no usable address')
    )
  })

  it('builds funding tx and calls funding_transaction_generated', async () => {
    handleEvent(new Event_FundingGenerationReady())

    // FundingGenerationReady is now async (IIFE) — wait for promises to settle
    await vi.waitFor(() => {
      expect(mockBdkWallet.build_tx).toHaveBeenCalled()
      expect(mockBdkWallet.sign).toHaveBeenCalled()
      expect(mockFundingTransactionGenerated).toHaveBeenCalledWith(
        expect.anything(), // temporary_channel_id
        expect.any(Uint8Array), // counterparty_node_id
        mockExtractedTxBytes // raw tx bytes from psbt.extract_tx().to_bytes()
      )
    })
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('funding tx registered'),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String)
    )
  })

  it('does not call funding_transaction_generated when IDB persist fails', async () => {
    const { idbPut: mockPut } = await import('../../storage/idb')
    vi.mocked(mockPut).mockRejectedValueOnce(new Error('IDB write failed'))

    handleEvent(new Event_FundingGenerationReady())

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        '[LDK Event]',
        'Failed to persist funding tx — aborting channel',
        expect.anything()
      )
    })
    expect(mockFundingTransactionGenerated).not.toHaveBeenCalled()
  })

  it('does not persist tx when funding_transaction_generated fails', async () => {
    mockFundingTransactionGenerated.mockReturnValueOnce({ is_ok: () => false })

    handleEvent(new Event_FundingGenerationReady())

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        '[LDK Event]',
        'FundingGenerationReady: funding_transaction_generated failed',
        ''
      )
    })
  })

  it('broadcasts persisted tx on FundingTxBroadcastSafe', async () => {
    // Mock IDB to return a persisted funding tx
    mockIdbGet.mockResolvedValueOnce('dead')

    handleEvent(new Event_FundingTxBroadcastSafe())

    // Allow the async IDB read + broadcast to resolve
    await vi.waitFor(() => {
      expect(mockBroadcastWithRetry).toHaveBeenCalledWith('https://test.esplora/api', 'dead')
    })
  })

  it('warns when FundingTxBroadcastSafe has no persisted tx', async () => {
    mockIdbGet.mockResolvedValueOnce(undefined)
    handleEvent(new Event_FundingTxBroadcastSafe())
    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('no persisted tx'),
        expect.any(String)
      )
    })
  })

  it('logs critical error on BumpTransaction', () => {
    handleEvent(new Event_BumpTransaction())
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('BumpTransaction'),
      expect.any(String),
      expect.any(String)
    )
  })

  it('silently handles PaymentPathSuccessful', () => {
    handleEvent(new Event_PaymentPathSuccessful())
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('silently handles PaymentPathFailed', () => {
    handleEvent(new Event_PaymentPathFailed())
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('rejects OpenChannelRequest from non-LSP peer', () => {
    handleEvent(new Event_OpenChannelRequest())
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('rejected from non-LSP'),
      expect.any(String)
    )
    expect(mockAcceptInboundChannel).not.toHaveBeenCalled()
    expect(mockAcceptInbound0conf).not.toHaveBeenCalled()
  })

  it('logs DiscardFunding', () => {
    handleEvent(new Event_DiscardFunding())
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('DiscardFunding'),
      expect.any(String)
    )
  })

  it('handles unknown events without throwing', () => {
    expect(() => handleEvent({})).not.toThrow()
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unhandled event'),
      expect.any(String)
    )
  })

  it('catches errors in handler without throwing', () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const badEvent = Object.assign(new Event_PaymentClaimable(), {
      purpose: null,
    })
    expect(() => handleEvent(badEvent)).not.toThrow()
    expect(errorSpy).toHaveBeenCalledWith(
      '[LDK Event]',
      'Unhandled error in event handler',
      expect.anything()
    )
  })
})
