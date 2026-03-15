import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockClaimFunds = vi.fn()
const mockProcessPendingHtlcForwards = vi.fn()
const mockFundingTransactionGenerated = vi.fn(() => ({ is_ok: () => true }))

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
  }
  class Event_PaymentFailed extends MockEvent {
    payment_hash = new Uint8Array([1, 2, 3])
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
  class Event_ChannelClosed extends MockEvent {
    channel_id = { write: () => new Uint8Array([7, 8]) }
    reason = 'CooperativeClosure'
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
    Event_DiscardFunding,
    Option_ThirtyTwoBytesZ_Some,
    Option_ThirtyTwoBytesZ_None,
    Result_NoneReplayEventZ: {
      constructor_ok: vi.fn(() => ({ is_ok: () => true })),
    },
  }
})

vi.mock('../storage/idb', () => ({
  idbPut: vi.fn(() => Promise.resolve()),
}))

const mockExtractTxBytes = vi.fn(() => new Uint8Array([0xde, 0xad]))
const mockBroadcastTransaction = vi.fn(() => Promise.resolve('txid123'))
vi.mock('../../onchain/tx-bridge', () => ({
  extractTxBytes: (...args: unknown[]) => mockExtractTxBytes(...args),
  broadcastTransaction: (...args: unknown[]) => mockBroadcastTransaction(...args),
}))

vi.mock('../../onchain/config', () => ({
  ONCHAIN_CONFIG: { esploraUrl: 'https://test.esplora/api' },
}))

vi.mock('../../onchain/storage/changeset', () => ({
  putChangeset: vi.fn(() => Promise.resolve()),
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
import {
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
  Event_OpenChannelRequest,
  Event_DiscardFunding,
  Option_ThirtyTwoBytesZ_None,
} from 'lightningdevkit'

function createMockChannelManager() {
  return {
    claim_funds: mockClaimFunds,
    process_pending_htlc_forwards: mockProcessPendingHtlcForwards,
    funding_transaction_generated: mockFundingTransactionGenerated,
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
    const result = createEventHandler(cm)
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
      'CooperativeClosure',
    )
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
    const result = createEventHandler(cm)
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

  it('does not cache tx when funding_transaction_generated fails', () => {
    mockFundingTransactionGenerated.mockReturnValueOnce({ is_ok: () => false })
    const cm = createMockChannelManager()
    const result = createEventHandler(cm)
    result.setBdkWallet(mockBdkWallet as never)
    const handler = (
      result.handler as unknown as { _impl: { handle_event: HandleEventFn } }
    )._impl.handle_event

    handler(new Event_FundingGenerationReady())

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('funding_transaction_generated failed'),
    )
    // Verify broadcast is never called (no cached tx)
    handler(new Event_FundingTxBroadcastSafe())
    expect(mockBroadcastTransaction).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no cached tx'),
      expect.any(String),
      expect.any(String),
    )
    result.cleanup()
  })

  it('broadcasts cached tx on FundingTxBroadcastSafe', async () => {
    // Set up with BDK wallet to populate the cache via FundingGenerationReady
    const cm = createMockChannelManager()
    const result = createEventHandler(cm)
    result.setBdkWallet(mockBdkWallet as never)
    const handler = (
      result.handler as unknown as { _impl: { handle_event: HandleEventFn } }
    )._impl.handle_event

    // First, trigger funding to populate cache
    handler(new Event_FundingGenerationReady())

    // Then trigger broadcast
    handler(new Event_FundingTxBroadcastSafe())

    // Allow the async broadcast to resolve
    await vi.waitFor(() => {
      expect(mockBroadcastTransaction).toHaveBeenCalledWith(
        'dead', // txBytesToHex result
        'https://test.esplora/api',
      )
    })
    result.cleanup()
  })

  it('warns when FundingTxBroadcastSafe has no cached tx', () => {
    handleEvent(new Event_FundingTxBroadcastSafe())
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no cached tx'),
      expect.any(String),
      expect.any(String),
    )
  })

  it('warns on BumpTransaction', () => {
    handleEvent(new Event_BumpTransaction())
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('BumpTransaction'),
    )
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
