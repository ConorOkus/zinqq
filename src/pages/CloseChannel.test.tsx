import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, vi } from 'vitest'

vi.mock('lightningdevkit', () => {
  class Option_ChannelShutdownStateZ {}
  class Option_ChannelShutdownStateZ_Some extends Option_ChannelShutdownStateZ {
    some: number
    constructor(some: number) {
      super()
      this.some = some
    }
  }
  class Balance {}
  class Balance_ClaimableOnChannelClose extends Balance {}
  class Option_u16Z {}
  class Option_u16Z_Some extends Option_u16Z {
    some: number
    constructor(some: number) {
      super()
      this.some = some
    }
  }
  return {
    Option_ChannelShutdownStateZ,
    Option_ChannelShutdownStateZ_Some,
    ChannelShutdownState: {
      LDKChannelShutdownState_NotShuttingDown: 0,
      LDKChannelShutdownState_NegotiatingClosingFee: 3,
    },
    Balance,
    Balance_ClaimableOnChannelClose,
    Option_u16Z,
    Option_u16Z_Some,
    ConfirmationTarget: { LDKConfirmationTarget_ChannelCloseMinimum: 6 },
  }
})

vi.mock('../storage/error-log', () => ({
  captureError: vi.fn(),
}))

import { Option_ChannelShutdownStateZ_Some } from 'lightningdevkit'
import { LdkContext, type LdkContextValue } from '../ldk/ldk-context'
import type { CloseEstimate } from '../ldk/close-records/estimate'
import { CloseChannel } from './CloseChannel'

// The vi.mock factory class has a public constructor; the real LDK binding
// doesn't (protected + WASM pointer args), so cast once for construction.
const ShutdownSomeCtor = Option_ChannelShutdownStateZ_Some as unknown as new (
  some: number
) => Option_ChannelShutdownStateZ_Some

const PUBKEY = '02' + 'ab'.repeat(32)
const PUBKEY_BYTES = new Uint8Array([0x02, ...Array.from({ length: 32 }, () => 0xab)])
const CHANNEL_ID_HEX = 'ab'

function fakeChannel(shutdownState = 0) {
  return {
    get_channel_id: () => ({ write: () => new Uint8Array([0xab]) }),
    get_counterparty: () => ({ get_node_id: () => PUBKEY_BYTES }),
    get_channel_value_satoshis: () => 1_000_000n,
    get_outbound_capacity_msat: () => 600_000_000n,
    get_inbound_capacity_msat: () => 300_000_000n,
    get_is_usable: () => true,
    get_is_channel_ready: () => true,
    get_channel_shutdown_state: () => new ShutdownSomeCtor(shutdownState),
  }
}

const fullEstimate: CloseEstimate = {
  feePayer: 'counterparty',
  coopCloseFeeSats: 875n,
  commitmentFeeSats: 0n,
  cpfpFeeSats: 1_000n,
  sweepFeeSats: 700n,
  coopTotalYouPaySats: 0n,
  forceTotalYouPaySats: 1_700n,
  expectedBackSats: 480_000n,
  timelockBlocks: 2016,
  pendingHtlcCount: 0,
  isAnchor: true,
}

function readyLdk(
  overrides?: Partial<Extract<LdkContextValue, { status: 'ready' }>>
): LdkContextValue {
  return {
    status: 'ready',
    node: {} as never,
    nodeId: 'abc123',
    error: null,
    syncStatus: 'synced',
    connectToPeer: async () => {},
    forgetPeer: async () => {},
    disconnectPeer: () => {},
    createChannel: () => true,
    closeChannel: vi.fn(() => true),
    forceCloseChannel: vi.fn(() => true),
    estimateClose: vi.fn(() => Promise.resolve(fullEstimate)),
    listChannels: vi.fn(() => [fakeChannel()] as never),
    bdkWallet: {} as never,
    bdkEsploraClient: {} as never,
    setSyncNeeded: () => {},
    sendBolt11Payment: () => new Uint8Array(),
    sendBolt12Payment: () => Promise.resolve(new Uint8Array()),
    abandonPayment: () => {},
    getPaymentResult: () => null,
    listRecentPayments: () => [],
    outboundCapacityMsat: () => 0n,
    lightningBalanceSats: 0n,
    createInvoice: () => ({ bolt11: 'lnbc1test', paymentHash: 'abc123' }),
    requestJitQuote: () => Promise.reject(new Error('not used in this test')),
    fetchMinJitReceiveSats: () => Promise.resolve(0n),
    executeJitBuy: () => Promise.reject(new Error('not used in this test')),
    channelChangeCounter: 0,
    peersReconnected: true,
    paymentHistory: [],
    bolt12Offer: null,
    vssStatus: 'ok',
    vssClient: null,
    shutdown: () => {},
    ...overrides,
  }
}

function renderCloseChannel(
  ldkValue: LdkContextValue,
  routeState: Record<string, unknown> = {
    channelIdHex: CHANNEL_ID_HEX,
    counterpartyPubkey: PUBKEY,
  }
) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/close-channel', state: routeState }]}>
      <LdkContext value={ldkValue}>
        <CloseChannel />
      </LdkContext>
    </MemoryRouter>
  )
}

describe('CloseChannel', () => {
  it('renders the estimate: amount back, zero cost for LSP-funded coop close, timeline', async () => {
    renderCloseChannel(readyLdk())

    expect(await screen.findByText('~₿480,000')).toBeInTheDocument()
    expect(await screen.findByText('~₿0')).toBeInTheDocument()
    expect(
      await screen.findByText(/closing fee is paid by the LSP — this close costs you nothing/i)
    ).toBeInTheDocument()
    expect(screen.getByText('~minutes once confirmed')).toBeInTheDocument()
  })

  it('force toggle shows the humanized timelock, force cost, and warning copy', async () => {
    renderCloseChannel(readyLdk())
    await screen.findByText('~₿480,000')

    await userEvent.click(screen.getByRole('button', { name: 'Force Close' }))

    expect(screen.getByText('up to ~14 days')).toBeInTheDocument()
    expect(screen.getByText('~₿1,700')).toBeInTheDocument()
    expect(screen.getByText(/You wait; the other side doesn't/i)).toBeInTheDocument()
    // Anchor channel → no non-anchor warning
    expect(screen.queryByText(/doesn't support anchor outputs/i)).not.toBeInTheDocument()
  })

  it('shows the non-anchor warning on force close for non-anchor channels', async () => {
    renderCloseChannel(
      readyLdk({
        estimateClose: vi.fn(() =>
          Promise.resolve({ ...fullEstimate, isAnchor: false, cpfpFeeSats: 0n })
        ),
      })
    )
    await screen.findByText('~₿480,000')

    await userEvent.click(screen.getByRole('button', { name: 'Force Close' }))
    expect(screen.getByText(/doesn't support anchor outputs/i)).toBeInTheDocument()
  })

  it('warns about in-flight payments when HTLCs are pending', async () => {
    renderCloseChannel(
      readyLdk({
        estimateClose: vi.fn(() => Promise.resolve({ ...fullEstimate, pendingHtlcCount: 2 })),
      })
    )

    expect(await screen.findByText(/2 in-flight payments/i)).toBeInTheDocument()
  })

  it('HARD TEST: closing works when the estimate API fails entirely', async () => {
    const closeChannel = vi.fn(() => true)
    renderCloseChannel(
      readyLdk({
        closeChannel,
        estimateClose: vi.fn(() => Promise.reject(new Error('everything is down'))),
      })
    )

    // Placeholders render instead of numbers; the button still works
    expect(await screen.findByText('Estimate unavailable')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Close Channel' }))
    expect(closeChannel).toHaveBeenCalledOnce()
    expect(await screen.findByText('Channel Closing')).toBeInTheDocument()
  })

  it('closing works when the estimate resolves null (channel unknown to estimator)', async () => {
    const closeChannel = vi.fn(() => true)
    renderCloseChannel(
      readyLdk({
        closeChannel,
        estimateClose: vi.fn(() => Promise.resolve(null)),
      })
    )

    expect(await screen.findByText('Estimate unavailable')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close Channel' }))
    expect(closeChannel).toHaveBeenCalledOnce()
  })

  it('preselects force close when routed with closeType force', async () => {
    renderCloseChannel(readyLdk(), {
      channelIdHex: CHANNEL_ID_HEX,
      counterpartyPubkey: PUBKEY,
      closeType: 'force',
    })

    expect(await screen.findByRole('button', { name: 'Force Close Channel' })).toBeInTheDocument()
  })

  it('force success screen uses the humanized timelock', async () => {
    const forceCloseChannel = vi.fn(() => true)
    renderCloseChannel(readyLdk({ forceCloseChannel }), {
      channelIdHex: CHANNEL_ID_HEX,
      counterpartyPubkey: PUBKEY,
      closeType: 'force',
    })
    await screen.findByText('~₿480,000')

    await userEvent.click(screen.getByRole('button', { name: 'Force Close Channel' }))
    expect(forceCloseChannel).toHaveBeenCalledOnce()
    expect(await screen.findByText(/accessible in ~14 days/i)).toBeInTheDocument()
  })
})
