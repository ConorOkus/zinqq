import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockClaimFunds = vi.fn()
const mockProcessPendingHtlcForwards = vi.fn()
const mockFundingTransactionGenerated = vi.fn((): { is_ok: () => boolean } => ({ is_ok: () => true }))
const mockListChannels = vi.fn((): unknown[] => [])
const mockOnChannelClosed = vi.fn()

vi.mock('lightningdevkit', () => {
  class MockEvent {}
  class Event_PaymentClaimable extends MockEvent {
    payment_hash = new Uint8Array([1, 2, 3])
    amount_msat = BigInt(100000)
    purpose = {
      preimage: () =>
        new Option_ThirtyTwoBytesZ_Some(new Uint8Array([4, 5, 6])),
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
  }
  class Event_ChannelReady extends MockEvent {
    channel_id = { write: () => new Uint8Array([7, 8]) }
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
  class Event_OpenChannelRequest extends MockEvent {}
  class Event_DiscardFunding extends MockEvent {
    channel_id = { write: () => new Uint8Array([0xee, 0xff]) }
    funding_info = {}
  }

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
      new_impl: vi.fn(
        (impl: { handle_event: (event: unknown) => unknown }) => ({
          _impl: impl,
        }),
      ),
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
    Result_NoneReplayEventZ: {
      constructor_ok: vi.fn(() => ({ is_ok: () => true })),
    },
  }
})

const mockIdbGet = vi.fn((): Promise<string | undefined> => Promise.resolve(undefined))
vi.mock('../storage/idb', () => ({
  idbPut: vi.fn(() => Promise.resolve()),
  idbGet: () => mockIdbGet(),
  idbDelete: vi.fn(() => Promise.resolve()),
  idbGetAll: vi.fn(() => Promise.resolve(new Map())),
}))

const mockExtractTxBytes = vi.fn((_psbt: string) => new Uint8Array([0xde, 0xad]))
const mockBroadcastTransaction = vi.fn((_txHex: string, _url: string) => Promise.resolve('txid123'))
vi.mock('../../onchain/tx-bridge', () => ({
  extractTxBytes: (psbt: string) => mockExtractTxBytes(psbt),
  broadcastTransaction: (txHex: string, url: string) => mockBroadcastTransaction(txHex, url),
}))

vi.mock('../../onchain/config', () => ({
  ONCHAIN_CONFIG: { esploraUrl: 'https://test.esplora/api' },
}))

vi.mock('../../onchain/storage/changeset', () => ({
  putChangeset: vi.fn(() => Promise.resolve()),
}))

vi.mock('../sweep', () => ({
  sweepSpendableOutputs: vi.fn(() => Promise.resolve({ swept: 0, skipped: 0, txid: null })),
}))

const mockPsbt = {
  toString: () => 'base64psbt',
}
const mockTxBuilder = {
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
      .join(''),
  ),
}))

import { createEventHandler } from './event-handler'
import { idbPut } from '../storage/idb'
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
} = ldk

function createMockKeysManager() {
  return {
    as_OutputSpender: vi.fn(() => ({
      spend_spendable_outputs: vi.fn(() => ({ is_ok: () => false })),
    })),
  } as never
}

function createMockChannelManager() {
  return {
    claim_funds: mockClaimFunds,
    process_pending_htlc_forwards: mockProcessPendingHtlcForwards,
    funding_transaction_generated: mockFundingTransactionGenerated,
    list_channels: mockListChannels,
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
    const result = createEventHandler(cm, km, undefined, mockOnChannelClosed)
    cleanup = result.cleanup
    handleEvent = (
      result.handler as unknown as { _impl: { handle_event: HandleEventFn } }
    )._impl.handle_event
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('claims payment on PaymentClaimable with preimage', () => {
    handleEvent(new Event_PaymentClaimable())
    expect(mockClaimFunds).toHaveBeenCalledWith(new Uint8Array([4, 5, 6]))
  })

  it('warns when PaymentClaimable has no preimage', () => {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
    const event = Object.assign(new Event_PaymentClaimable(), {
      purpose: { preimage: () => new Option_ThirtyTwoBytesZ_None() },
    })
    /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
    handleEvent(event)
    expect(mockClaimFunds).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no preimage'),
      expect.any(String),
      expect.stringContaining('cannot be claimed'),
    )
  })

  it('logs PaymentClaimed', () => {
    handleEvent(new Event_PaymentClaimed())
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('PaymentClaimed'),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    )
  })

  it('logs PaymentSent', () => {
    handleEvent(new Event_PaymentSent())
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('PaymentSent'),
      expect.any(String),
    )
  })

  it('warns on PaymentFailed', () => {
    handleEvent(new Event_PaymentFailed())
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('PaymentFailed'),
      expect.any(String),
      expect.any(String),
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
    expect(idbPut).toHaveBeenCalledWith(
      'ldk_spendable_outputs',
      expect.any(String),
      [expect.any(Uint8Array)],
    )
  })

  it('logs "persisting" for SpendableOutputs', () => {
    handleEvent(new Event_SpendableOutputs())
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('persisting'),
      expect.any(Number),
      expect.any(String),
    )
  })

  it('logs ChannelPending', () => {
    handleEvent(new Event_ChannelPending())
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('ChannelPending'),
      expect.any(String),
    )
  })

  it('logs ChannelReady', () => {
    handleEvent(new Event_ChannelReady())
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('ChannelReady'),
      expect.any(String),
    )
  })

  it('logs ChannelClosed with reason', () => {
    handleEvent(new Event_ChannelClosed())
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('ChannelClosed'),
      expect.any(String),
      'reason:',
      'Cooperative close',
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
    const result = createEventHandler(cm, createMockKeysManager(), undefined, undefined, mockSyncNeeded)
    const handler = (
      result.handler as unknown as { _impl: { handle_event: HandleEventFn } }
    )._impl.handle_event

    handler(new Event_ChannelClosed())
    expect(mockSyncNeeded).toHaveBeenCalledOnce()
    result.cleanup()
  })

  it('warns on ConnectionNeeded (not yet implemented)', () => {
    handleEvent(new Event_ConnectionNeeded())
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ConnectionNeeded'),
      expect.any(String),
      expect.stringContaining('not yet implemented'),
    )
  })

  it('warns when FundingGenerationReady fires without BDK wallet', () => {
    handleEvent(new Event_FundingGenerationReady())
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('BDK wallet not available'),
    )
    expect(mockFundingTransactionGenerated).not.toHaveBeenCalled()
  })

  it('builds funding tx and calls funding_transaction_generated with BDK wallet', () => {
    const cm = createMockChannelManager()
    const result = createEventHandler(cm, createMockKeysManager())
    result.setBdkWallet(mockBdkWallet as never)
    const handler = (
      result.handler as unknown as { _impl: { handle_event: HandleEventFn } }
    )._impl.handle_event

    handler(new Event_FundingGenerationReady())

    expect(mockBdkWallet.build_tx).toHaveBeenCalled()
    expect(mockBdkWallet.sign).toHaveBeenCalled()
    expect(mockExtractTxBytes).toHaveBeenCalledWith('base64psbt')
    expect(mockFundingTransactionGenerated).toHaveBeenCalledWith(
      expect.anything(), // temporary_channel_id
      expect.any(Uint8Array), // counterparty_node_id
      new Uint8Array([0xde, 0xad]), // raw tx bytes from bridge
    )
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('funding tx registered'),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    )
    result.cleanup()
  })

  it('does not persist tx when funding_transaction_generated fails', () => {
    mockFundingTransactionGenerated.mockReturnValueOnce({ is_ok: () => false })
    const cm = createMockChannelManager()
    const result = createEventHandler(cm, createMockKeysManager())
    result.setBdkWallet(mockBdkWallet as never)
    const handler = (
      result.handler as unknown as { _impl: { handle_event: HandleEventFn } }
    )._impl.handle_event

    handler(new Event_FundingGenerationReady())

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('funding_transaction_generated failed'),
    )
    result.cleanup()
  })

  it('broadcasts persisted tx on FundingTxBroadcastSafe', async () => {
    // Mock IDB to return a persisted funding tx
    mockIdbGet.mockResolvedValueOnce('dead')

    const cm = createMockChannelManager()
    const result = createEventHandler(cm, createMockKeysManager())
    const handler = (
      result.handler as unknown as { _impl: { handle_event: HandleEventFn } }
    )._impl.handle_event

    handler(new Event_FundingTxBroadcastSafe())

    // Allow the async IDB read + broadcast to resolve
    await vi.waitFor(() => {
      expect(mockBroadcastTransaction).toHaveBeenCalledWith(
        'dead',
        'https://test.esplora/api',
      )
    })
    result.cleanup()
  })

  it('warns when FundingTxBroadcastSafe has no persisted tx', async () => {
    mockIdbGet.mockResolvedValueOnce(undefined)
    handleEvent(new Event_FundingTxBroadcastSafe())
    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('no persisted tx'),
        expect.any(String),
      )
    })
  })

  it('warns on BumpTransaction', () => {
    handleEvent(new Event_BumpTransaction())
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('BumpTransaction'),
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

  it('logs OpenChannelRequest with timeout note', () => {
    handleEvent(new Event_OpenChannelRequest())
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('will timeout'),
    )
  })

  it('logs DiscardFunding', () => {
    handleEvent(new Event_DiscardFunding())
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('DiscardFunding'),
      expect.any(String),
    )
  })

  it('handles unknown events without throwing', () => {
    expect(() => handleEvent({})).not.toThrow()
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unhandled event'),
      expect.any(String),
    )
  })

  it('catches errors in handler without throwing', () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const badEvent = Object.assign(new Event_PaymentClaimable(), {
      purpose: null,
    })
    expect(() => handleEvent(badEvent)).not.toThrow()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unhandled error'),
      expect.anything(),
    )
  })
})
