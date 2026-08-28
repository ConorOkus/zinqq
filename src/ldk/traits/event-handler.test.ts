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
  class Event_SpendableOutputs extends MockEvent {
    outputs = [
      {
        write: () => new Uint8Array([10, 20, 30]),
        spendable_outpoint: () => ({
          get_txid: () => new Uint8Array(32),
          get_index: () => 0,
        }),
      },
    ]
    channel_id = { write: () => new Uint8Array([7, 8]) }
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
  class SpendableOutputDescriptor {}
  class SpendableOutputDescriptor_StaticOutput extends SpendableOutputDescriptor {}
  class SpendableOutputDescriptor_DelayedPaymentOutput extends SpendableOutputDescriptor {}
  class SpendableOutputDescriptor_StaticPaymentOutput extends SpendableOutputDescriptor {}
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
  class Event_BumpTransaction extends MockEvent {
    bump_transaction = {}
  }
  class BumpTransactionEvent_ChannelClose {}
  class BumpTransactionEvent_HTLCResolution {}
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

  class Option_u16Z_Some {
    some: number
    constructor(s: number) {
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
    Event_SpendableOutputs,
    Event_ChannelPending,
    Event_ChannelReady,
    Event_ChannelClosed,
    Event_FundingGenerationReady,
    Event_FundingTxBroadcastSafe,
    Event_OpenChannelRequest,
    Event_ConnectionNeeded,
    Event_BumpTransaction,
    BumpTransactionEvent_ChannelClose,
    BumpTransactionEvent_HTLCResolution,
    Event_PaymentPathSuccessful,
    Event_PaymentPathFailed,
    Event_DiscardFunding,
    Event_HTLCHandlingFailed,
    PaymentPurpose_Bolt11InvoicePayment,
    PaymentPurpose_SpontaneousPayment,
    Option_ThirtyTwoBytesZ_Some,
    Option_ThirtyTwoBytesZ_None,
    Option_u64Z_Some,
    Option_u16Z_Some,
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
    SpendableOutputDescriptor,
    SpendableOutputDescriptor_StaticOutput,
    SpendableOutputDescriptor_DelayedPaymentOutput,
    SpendableOutputDescriptor_StaticPaymentOutput,
    SocketAddress_TcpIpV4,
    SocketAddress_TcpIpV6,
    SocketAddress_Hostname,
    Result_NoneReplayEventZ: {
      constructor_ok: vi.fn(() => ({ is_ok: () => true })),
    },
    Result_NoneAPIErrorZ_Err: class {},
    // JIT 0-conf channel config overrides (Phase 4). Structured so tests can
    // assert the pinned settings reach the accept call.
    ChannelConfigOverrides: {
      constructor_new: vi.fn((handshake: unknown, update: unknown) => ({ handshake, update })),
    },
    ChannelConfigUpdate: {
      constructor_new: vi.fn((...args: unknown[]) => ({ acceptUnderpayingHtlcs: args[5] })),
    },
    ChannelHandshakeConfigUpdate: {
      constructor_new: vi.fn((...args: unknown[]) => ({ maxInboundInflightPercent: args[0] })),
    },
    Option_boolZ: {
      constructor_some: vi.fn((v: boolean) => ({ some: v })),
      constructor_none: vi.fn(() => null),
    },
    Option_u8Z: {
      constructor_some: vi.fn((v: number) => ({ some: v })),
      constructor_none: vi.fn(() => null),
    },
    Option_u16Z: { constructor_none: vi.fn(() => null) },
    Option_u32Z: { constructor_none: vi.fn(() => null) },
    Option_u64Z: { constructor_none: vi.fn(() => null) },
    Option_MaxDustHTLCExposureZ: { constructor_none: vi.fn(() => null) },
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
  sweepSpendableOutputs: vi.fn(() => Promise.resolve({ swept: 0, skipped: 0, txs: [] })),
  isWalletOwnedStaticOutput: vi.fn(() => false),
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
  Transaction: {
    from_bytes: vi.fn(() => ({ compute_txid: () => ({ toString: () => 'commitment-txid' }) })),
  },
}))

vi.mock('../utils', () => ({
  bytesToHex: vi.fn((bytes: Uint8Array) =>
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  ),
  txidBytesToHex: vi.fn((bytes: Uint8Array) =>
    Array.from(bytes)
      .reverse()
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  ),
}))

import { createEventHandler } from './event-handler'
import { idbPut } from '../../storage/idb'
import { sweepSpendableOutputs, isWalletOwnedStaticOutput } from '../sweep'

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ldk: any = await import('lightningdevkit')
const {
  Event_PaymentClaimable,
  Event_PaymentClaimed,
  Event_PaymentSent,
  Event_PaymentFailed,
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
      () => false, // isTrustedLsp — never trust in this default test setup
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

  // F3 in the async-payments plan claims a payment against the async-receive
  // offer settles through this handler with no new code. The claim branch is
  // purpose-agnostic — it turns only on `preimage()` — so pin that a BOLT 12
  // offer purpose reaches `claim_funds` rather than the timeout warning.
  it('claims a BOLT 12 offer payment, not just BOLT 11', () => {
    // Only member-access needs disabling here; no-unsafe-assignment and
    // no-unsafe-call are already off file-wide from the directive above the
    // mocked-module import. Re-enabling them would cancel that for the rest of
    // the file.
    /* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
    const event = new Event_PaymentClaimable()
    event.purpose = {
      preimage: () => new ldk.Option_ThirtyTwoBytesZ_Some(new Uint8Array([9, 9, 9])),
      constructor: { name: 'PaymentPurpose_Bolt12OfferPayment' },
    }
    /* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */

    handleEvent(event)

    expect(mockClaimFunds).toHaveBeenCalledWith(new Uint8Array([9, 9, 9]))
    expect(warnSpy).not.toHaveBeenCalled()
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

  // LDK 0.2 removed Event::PendingHTLCsForwardable — HTLC forwarding is now
  // driven by the background poll loop (needs_pending_htlc_processing +
  // process_pending_htlc_forwards) in context.tsx, so the former
  // event-scheduling / timer-cleanup tests no longer apply.

  it('persists SpendableOutputs to IDB with channel attribution', () => {
    handleEvent(new Event_SpendableOutputs())
    expect(idbPut).toHaveBeenCalledWith(
      'ldk_spendable_outputs',
      expect.any(String),
      expect.objectContaining({
        descriptors: [expect.any(Uint8Array)],
        channelIdHex: '0708',
        outpoints: [expect.objectContaining({ vout: 0, valueSats: '0' })],
      })
    )
  })

  it('skips persisting SpendableOutputs that already pay to the on-chain wallet', async () => {
    // Wallet-owned StaticOutputs need no sweep — and KeysManager cannot sign
    // them, so persisting one would poison every future sweep batch.
    vi.mocked(isWalletOwnedStaticOutput).mockReturnValueOnce(true)
    handleEvent(new Event_SpendableOutputs())
    expect(idbPut).not.toHaveBeenCalledWith(
      'ldk_spendable_outputs',
      expect.any(String),
      expect.anything()
    )
    // Older pending entries must still get their retry.
    await vi.advanceTimersByTimeAsync(0)
    expect(sweepSpendableOutputs).toHaveBeenCalled()
  })

  it('persists descriptors even when outpoint extraction throws (fund-safety)', () => {
    const evt = new Event_SpendableOutputs() as unknown as {
      outputs: { spendable_outpoint: () => unknown }[]
    }
    const first = evt.outputs[0]
    if (!first) throw new Error('mock output missing')
    first.spendable_outpoint = () => {
      throw new Error('binding edge case')
    }
    handleEvent(evt as never)
    // The descriptors write is the fund-safety payload — it must survive a
    // throwing attribution accessor; attribution degrades to empty.
    expect(idbPut).toHaveBeenCalledWith(
      'ldk_spendable_outputs',
      expect.any(String),
      expect.objectContaining({ descriptors: [expect.any(Uint8Array)], outpoints: [] })
    )
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
      () => false,
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
      () => false,
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
      () => false,
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

// Trust-set behavior for Event_OpenChannelRequest. The default suite above
// uses `() => false` (never trust). These tests exercise the predicate
// directly so we can assert primary/fallback/dynamic-update semantics —
// the failure mode that PR #148 (LSP failover) introduced before todo 291
// was fixed.
describe('createEventHandler — Event_OpenChannelRequest trust set', () => {
  let cleanup: () => void
  let handleEvent: HandleEventFn
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})

  // Pubkey emitted by the mock Event_OpenChannelRequest above:
  // `new Uint8Array(33).fill(0x02)` → 66 hex chars of '02'.
  const COUNTERPARTY_HEX = '02'.repeat(33)

  function setup(isTrustedLsp: (pubkey: string) => boolean): void {
    const cm = createMockChannelManager()
    const km = createMockKeysManager()
    const result = createEventHandler(cm, km, mockBdkWallet as never, isTrustedLsp)
    cleanup = result.cleanup
    handleEvent = (result.handler as unknown as { _impl: { handle_event: HandleEventFn } })._impl
      .handle_event
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('accepts 0-conf when predicate returns true for the counterparty', () => {
    setup((pubkey) => pubkey === COUNTERPARTY_HEX)
    handleEvent(new Event_OpenChannelRequest())
    expect(mockAcceptInbound0conf).toHaveBeenCalledTimes(1)
    expect(mockAcceptInboundChannel).not.toHaveBeenCalled()
  })

  it('pins JIT channel config overrides on the 0-conf accept', () => {
    setup((pubkey) => pubkey === COUNTERPARTY_HEX)
    handleEvent(new Event_OpenChannelRequest())
    expect(mockAcceptInbound0conf).toHaveBeenCalledTimes(1)
    const overrides = (mockAcceptInbound0conf.mock.calls[0] as unknown[])[3] as {
      handshake: { maxInboundInflightPercent: { some: number } }
      update: { acceptUnderpayingHtlcs: { some: boolean } }
    }
    expect(overrides).not.toBeNull()
    expect(overrides.update.acceptUnderpayingHtlcs).toEqual({ some: true })
    expect(overrides.handshake.maxInboundInflightPercent).toEqual({ some: 100 })
  })

  it('rejects 0-conf when predicate returns false', () => {
    setup(() => false)
    handleEvent(new Event_OpenChannelRequest())
    expect(mockAcceptInbound0conf).not.toHaveBeenCalled()
    expect(mockAcceptInboundChannel).not.toHaveBeenCalled()
  })

  it('reflects mutable trust-set updates between calls (runtime-added LSP)', () => {
    // Initial state: some other LSP trusted; the counterparty is not yet.
    const trusted = new Set<string>(['other-lsp-pubkey'])
    setup((pubkey) => trusted.has(pubkey))

    // First open from an untrusted pubkey: rejected.
    handleEvent(new Event_OpenChannelRequest())
    expect(mockAcceptInbound0conf).not.toHaveBeenCalled()

    // The counterparty's pubkey is added to the trust set at runtime.
    trusted.add(COUNTERPARTY_HEX)

    // Second open from the same counterparty: accepted via the live
    // closure read.
    handleEvent(new Event_OpenChannelRequest())
    expect(mockAcceptInbound0conf).toHaveBeenCalledTimes(1)
  })

  it('trusts multiple LSPs simultaneously (primary + fallback)', () => {
    const trusted = new Set<string>([COUNTERPARTY_HEX, 'megalith-pubkey'])
    setup((pubkey) => trusted.has(pubkey))

    handleEvent(new Event_OpenChannelRequest())
    expect(mockAcceptInbound0conf).toHaveBeenCalledTimes(1)
  })
})
