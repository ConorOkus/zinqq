import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router'
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
  return {
    Option_ChannelShutdownStateZ,
    Option_ChannelShutdownStateZ_Some,
    ChannelShutdownState: {
      LDKChannelShutdownState_NotShuttingDown: 0,
      LDKChannelShutdownState_NegotiatingClosingFee: 3,
    },
    // Pulled in transitively via peer-connection → config
    Network: { LDKNetwork_Bitcoin: 0 },
  }
})

// Channels only render under peers that are known or connected, so the
// test peer must exist in the known-peers store. (The pubkey literal is
// inlined because vi.mock factories are hoisted above file constants.)
vi.mock('../ldk/storage/known-peers', () => {
  const pubkey = '02' + 'ab'.repeat(32)
  return {
    getKnownPeers: vi.fn(() =>
      Promise.resolve(new Map([[pubkey, { pubkey, host: 'lsp.example', port: 9735 }]]))
    ),
  }
})

import { Option_ChannelShutdownStateZ_Some } from 'lightningdevkit'
import { LdkContext, type LdkContextValue } from '../ldk/ldk-context'
import { Peers } from './Peers'

// The vi.mock factory class has a public constructor; the real LDK binding
// doesn't (protected + WASM pointer args), so cast once for construction.
const ShutdownSomeCtor = Option_ChannelShutdownStateZ_Some as unknown as new (
  some: number
) => Option_ChannelShutdownStateZ_Some

const PUBKEY_BYTES = new Uint8Array([0x02, ...Array.from({ length: 32 }, () => 0xab)])

const NOT_SHUTTING_DOWN = 0
const NEGOTIATING_CLOSING_FEE = 3

function fakeChannel(shutdownState: number) {
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

function readyLdk(channels: unknown[]): LdkContextValue {
  return {
    status: 'ready',
    node: {
      peerManager: { list_peers: () => [] },
      channelManager: { list_channels: () => channels },
    } as never,
    nodeId: 'abc123',
    error: null,
    syncStatus: 'synced',
    connectToPeer: async () => {},
    forgetPeer: async () => {},
    disconnectPeer: () => {},
    createChannel: () => true,
    closeChannel: () => true,
    forceCloseChannel: () => true,
    estimateClose: () => Promise.resolve(null),
    listChannels: () => channels as never,
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
    executeJitBuy: () => Promise.reject(new Error('not used in this test')),
    channelChangeCounter: 0,
    peersReconnected: true,
    paymentHistory: [],
    bolt12Offer: null,
    vssStatus: 'ok',
    vssClient: null,
    shutdown: () => {},
  }
}

/** Captures the route state CloseChannel would receive. */
function CloseChannelProbe() {
  const location = useLocation()
  const state = (location.state ?? {}) as { closeType?: string; channelIdHex?: string }
  return (
    <div>
      probe closeType={state.closeType ?? 'none'} channel={state.channelIdHex ?? 'missing'}
    </div>
  )
}

function renderPeers(ldkValue: LdkContextValue) {
  return render(
    <MemoryRouter initialEntries={['/settings/advanced/peers']}>
      <LdkContext value={ldkValue}>
        <Routes>
          <Route path="/settings/advanced/peers" element={<Peers />} />
          <Route path="/settings/advanced/peers/close-channel" element={<CloseChannelProbe />} />
        </Routes>
      </LdkContext>
    </MemoryRouter>
  )
}

describe('Peers — channel shutdown state', () => {
  it('renders a healthy channel as Active with a plain Close button', async () => {
    renderPeers(readyLdk([fakeChannel(NOT_SHUTTING_DOWN)]))

    expect(await screen.findByText('Active')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    expect(screen.queryByText('Closing…')).not.toBeInTheDocument()
  })

  it('renders a stalled cooperative close with badge, explainer, and Force Close', async () => {
    renderPeers(readyLdk([fakeChannel(NEGOTIATING_CLOSING_FEE)]))

    expect(await screen.findByText('Closing…')).toBeInTheDocument()
    expect(screen.getByText(/you can force close instead/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Force Close' })).toBeInTheDocument()
    expect(screen.queryByText('Active')).not.toBeInTheDocument()
  })

  it('Force Close routes to CloseChannel with force preselected', async () => {
    renderPeers(readyLdk([fakeChannel(NEGOTIATING_CLOSING_FEE)]))

    await userEvent.click(await screen.findByRole('button', { name: 'Force Close' }))
    expect(await screen.findByText('probe closeType=force channel=ab')).toBeInTheDocument()
  })

  it('plain Close routes without a closeType', async () => {
    renderPeers(readyLdk([fakeChannel(NOT_SHUTTING_DOWN)]))

    await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
    expect(await screen.findByText('probe closeType=none channel=ab')).toBeInTheDocument()
  })
})
