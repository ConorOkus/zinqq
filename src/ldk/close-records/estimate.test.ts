import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('lightningdevkit', () => {
  class Balance {}
  class Balance_ClaimableOnChannelClose extends Balance {
    balance_candidates: unknown[]
    confirmed_balance_candidate_index: number
    constructor(balance_candidates: unknown[], confirmed_balance_candidate_index: number) {
      super()
      this.balance_candidates = balance_candidates
      this.confirmed_balance_candidate_index = confirmed_balance_candidate_index
    }
  }
  class Option_u16Z {}
  class Option_u16Z_Some extends Option_u16Z {
    some: number
    constructor(some: number) {
      super()
      this.some = some
    }
  }
  class Option_u16Z_None extends Option_u16Z {}
  return {
    Balance,
    Balance_ClaimableOnChannelClose,
    Option_u16Z,
    Option_u16Z_Some,
    Option_u16Z_None,
    ConfirmationTarget: { LDKConfirmationTarget_ChannelCloseMinimum: 6 },
  }
})

vi.mock('../../shared/fee-cache', () => ({
  getFeeRate: vi.fn(() => Promise.resolve(5)), // sat/vB for both 6- and 3-block targets
}))

vi.mock('../traits/fee-estimator', () => ({
  computeFeeRateSatKw: vi.fn(() => 1250), // → coop close fee = 1250 × 700 / 1000 = 875 sats
}))

vi.mock('../../storage/error-log', () => ({
  captureError: vi.fn(),
}))

import {
  Balance_ClaimableOnChannelClose,
  Option_u16Z_Some,
  Option_u16Z_None,
} from 'lightningdevkit'
import { estimateClose, humanizeBlocks, type CloseEstimateDeps } from './estimate'
import { getFeeRate } from '../../shared/fee-cache'

// The vi.mock factory classes above have public constructors; the real LDK
// bindings don't (protected + WASM pointer args), so cast once for construction.
const OnCloseBalanceCtor = Balance_ClaimableOnChannelClose as unknown as new (
  balance_candidates: unknown[],
  confirmed_balance_candidate_index: number
) => Balance_ClaimableOnChannelClose
const U16SomeCtor = Option_u16Z_Some as unknown as new (some: number) => Option_u16Z_Some
const U16NoneCtor = Option_u16Z_None as unknown as new () => Option_u16Z_None

const CHANNEL_ID_HEX = 'ab'

function candidate(amountSats: bigint, feeSats: bigint) {
  return {
    get_amount_satoshis: () => amountSats,
    get_transaction_fee_satoshis: () => feeSats,
  }
}

function onCloseBalance(amountSats: bigint, feeSats: bigint) {
  return new OnCloseBalanceCtor([candidate(amountSats, feeSats)], 0)
}

function fakeChannel(overrides: Record<string, unknown> = {}) {
  return {
    get_channel_id: () => ({ write: () => new Uint8Array([0xab]) }),
    get_is_outbound: () => false,
    get_force_close_spend_delay: () => new U16SomeCtor(2016),
    get_pending_inbound_htlcs: () => [],
    get_pending_outbound_htlcs: () => [],
    get_channel_type: () => ({ supports_anchors_zero_fee_htlc_tx: () => true }),
    get_outbound_capacity_msat: () => 500_000_000n,
    ...overrides,
  }
}

function makeDeps(channels: unknown[], balances: unknown[] | (() => unknown[])): CloseEstimateDeps {
  return {
    channelManager: { list_channels: () => channels } as never,
    chainMonitor: {
      get_claimable_balances: typeof balances === 'function' ? balances : () => balances,
    } as never,
  }
}

beforeEach(() => {
  vi.mocked(getFeeRate).mockImplementation(() => Promise.resolve(5))
})

describe('estimateClose', () => {
  it('returns null when the channel is not found', async () => {
    const deps = makeDeps([fakeChannel()], [])
    expect(await estimateClose(deps, 'ffff')).toBeNull()
  })

  it('inbound (LSP-funded) channel: user pays nothing for coop, only CPFP+sweep for force', async () => {
    const deps = makeDeps([fakeChannel()], [onCloseBalance(480_000n, 2_000n)])
    const est = await estimateClose(deps, CHANNEL_ID_HEX)

    expect(est).not.toBeNull()
    expect(est?.feePayer).toBe('counterparty')
    expect(est?.commitmentFeeSats).toBe(2_000n)
    expect(est?.expectedBackSats).toBe(480_000n)
    expect(est?.coopTotalYouPaySats).toBe(0n)
    // CPFP (5 sat/vB × 200 vB) + sweep (5 sat/vB × 140 vB)
    expect(est?.forceTotalYouPaySats).toBe(1_700n)
    expect(est?.timelockBlocks).toBe(2016)
    expect(est?.isAnchor).toBe(true)
    expect(est?.pendingHtlcCount).toBe(0)
  })

  it('outbound channel: user pays the coop close fee and the commitment fee on force', async () => {
    const deps = makeDeps(
      [fakeChannel({ get_is_outbound: () => true })],
      [onCloseBalance(480_000n, 2_000n)]
    )
    const est = await estimateClose(deps, CHANNEL_ID_HEX)

    expect(est?.feePayer).toBe('you')
    expect(est?.coopCloseFeeSats).toBe(875n)
    expect(est?.coopTotalYouPaySats).toBe(875n)
    // commitment 2000 + CPFP 1000 + sweep 700
    expect(est?.forceTotalYouPaySats).toBe(3_700n)
  })

  it('non-anchor channel: no CPFP cost, isAnchor false', async () => {
    const deps = makeDeps(
      [
        fakeChannel({
          get_channel_type: () => ({ supports_anchors_zero_fee_htlc_tx: () => false }),
        }),
      ],
      [onCloseBalance(480_000n, 2_000n)]
    )
    const est = await estimateClose(deps, CHANNEL_ID_HEX)

    expect(est?.isAnchor).toBe(false)
    expect(est?.cpfpFeeSats).toBe(0n)
    expect(est?.forceTotalYouPaySats).toBe(700n) // sweep only (inbound channel)
  })

  it('counts pending HTLCs across both directions', async () => {
    const deps = makeDeps(
      [
        fakeChannel({
          get_pending_inbound_htlcs: () => [{}, {}],
          get_pending_outbound_htlcs: () => [{}],
        }),
      ],
      []
    )
    const est = await estimateClose(deps, CHANNEL_ID_HEX)
    expect(est?.pendingHtlcCount).toBe(3)
  })

  it('falls back to outbound capacity when no ClaimableOnChannelClose balance exists', async () => {
    const deps = makeDeps([fakeChannel()], [])
    const est = await estimateClose(deps, CHANNEL_ID_HEX)
    expect(est?.commitmentFeeSats).toBeNull()
    expect(est?.expectedBackSats).toBe(500_000n)
  })

  it('leaves the commitment fee unknown when balance attribution is ambiguous (>1 entry)', async () => {
    const deps = makeDeps(
      [fakeChannel()],
      [onCloseBalance(480_000n, 2_000n), onCloseBalance(100_000n, 1_000n)]
    )
    const est = await estimateClose(deps, CHANNEL_ID_HEX)
    expect(est?.commitmentFeeSats).toBeNull()
  })

  it('outbound + unknown commitment fee → force total unavailable, coop total still computed', async () => {
    const deps = makeDeps([fakeChannel({ get_is_outbound: () => true })], () => {
      throw new Error('monitor unavailable')
    })
    const est = await estimateClose(deps, CHANNEL_ID_HEX)
    expect(est?.forceTotalYouPaySats).toBeNull()
    expect(est?.coopTotalYouPaySats).toBe(875n)
  })

  it('survives every per-field read failing — never throws, all fields null', async () => {
    const throwing = () => {
      throw new Error('WASM detonated')
    }
    const deps = makeDeps(
      [
        fakeChannel({
          get_is_outbound: throwing,
          get_force_close_spend_delay: throwing,
          get_pending_inbound_htlcs: throwing,
          get_channel_type: throwing,
          get_outbound_capacity_msat: throwing,
        }),
      ],
      throwing
    )
    const est = await estimateClose(deps, CHANNEL_ID_HEX)

    expect(est).not.toBeNull()
    expect(est?.feePayer).toBe('unknown')
    expect(est?.timelockBlocks).toBeNull()
    expect(est?.expectedBackSats).toBeNull()
    expect(est?.coopTotalYouPaySats).toBeNull()
    expect(est?.forceTotalYouPaySats).toBeNull()
  })

  it('survives list_channels failing — returns an all-null estimate', async () => {
    const deps: CloseEstimateDeps = {
      channelManager: {
        list_channels: () => {
          throw new Error('node gone')
        },
      } as never,
      chainMonitor: { get_claimable_balances: () => [] } as never,
    }
    const est = await estimateClose(deps, CHANNEL_ID_HEX)
    expect(est).not.toBeNull()
    expect(est?.feePayer).toBe('unknown')
    expect(est?.expectedBackSats).toBeNull()
  })

  it('fee API failure nulls fee fields but keeps channel facts', async () => {
    vi.mocked(getFeeRate).mockImplementation(() => Promise.reject(new Error('esplora down')))
    const deps = makeDeps([fakeChannel()], [onCloseBalance(480_000n, 2_000n)])
    const est = await estimateClose(deps, CHANNEL_ID_HEX)

    expect(est?.coopCloseFeeSats).toBeNull()
    expect(est?.sweepFeeSats).toBeNull()
    expect(est?.forceTotalYouPaySats).toBeNull()
    expect(est?.coopTotalYouPaySats).toBeNull()
    expect(est?.timelockBlocks).toBe(2016)
    expect(est?.expectedBackSats).toBe(480_000n)
  })

  it('unknown anchor support keeps CPFP and force total unknown, never zero', async () => {
    const deps = makeDeps(
      [
        fakeChannel({
          get_channel_type: () => {
            throw new Error('channel_type read failed')
          },
        }),
      ],
      [onCloseBalance(480_000n, 2_000n)]
    )
    const est = await estimateClose(deps, CHANNEL_ID_HEX)

    expect(est?.isAnchor).toBeNull()
    expect(est?.cpfpFeeSats).toBeNull()
    expect(est?.forceTotalYouPaySats).toBeNull()
    expect(est?.sweepFeeSats).toBe(700n)
  })

  it('handles a None force_close_spend_delay', async () => {
    const deps = makeDeps(
      [fakeChannel({ get_force_close_spend_delay: () => new U16NoneCtor() })],
      []
    )
    const est = await estimateClose(deps, CHANNEL_ID_HEX)
    expect(est?.timelockBlocks).toBeNull()
  })
})

describe('humanizeBlocks', () => {
  it('renders minutes under an hour', () => {
    expect(humanizeBlocks(3)).toBe('~30 minutes')
  })
  it('renders a singular hour', () => {
    expect(humanizeBlocks(6)).toBe('~1 hour')
  })
  it('renders hours under two days', () => {
    expect(humanizeBlocks(144)).toBe('~24 hours')
  })
  it('renders days beyond two days', () => {
    expect(humanizeBlocks(2016)).toBe('~14 days')
  })
})
