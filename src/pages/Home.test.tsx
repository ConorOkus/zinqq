import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import type { StableSnapshot } from '../stable/types'
import { initialStableState } from '../stable/store'
import { LdkContext, defaultLdkContextValue, type LdkContextValue } from '../ldk/ldk-context'
import {
  OnchainContext,
  defaultOnchainContextValue,
  type OnchainContextValue,
} from '../onchain/onchain-context'
import { Home } from './Home'

let stable: StableSnapshot
const provider = { nodeId: '02' + '7'.repeat(64), host: 'stablechannels.com', port: 9735 }
const channelId = '1'.repeat(64)
vi.mock('../stable/use-stable-balance', () => ({ useStableBalance: () => stable }))
beforeEach(() => {
  stable = {
    state: initialStableState(provider),
    channel: null,
    price: null,
    priceFresh: false,
    status: 'Not enabled',
    error: null,
    busy: false,
  }
})

function allocatedDollars() {
  stable = {
    ...stable,
    state: {
      ...initialStableState(provider),
      enabled: true,
      position: {
        channelId,
        targetUsd: 100,
        backingSats: '100000',
        syncVersion: '1',
        lastSettlementAt: 0,
        receipts: {},
      },
    },
    channel: {
      channelId,
      userChannelId: '7',
      receiverSats: 200000n,
      spendableSats: 200000n,
      inboundSats: 200000n,
      usable: true,
    },
    price: {
      priceCents: 9_900_000n,
      observedAt: 1000,
      sources: ['Coinbase', 'Kraken', 'Bitstamp'],
    },
    priceFresh: true,
    status: 'Awaiting provider settlement',
  }
}

/* eslint-disable @typescript-eslint/require-await */

function readyOnchain(
  overrides: Partial<Extract<OnchainContextValue, { status: 'ready' }>> = {}
): OnchainContextValue {
  return {
    status: 'ready',
    balance: { confirmed: 100000n, trustedPending: 0n, untrustedPending: 0n },
    generateAddress: () => 'bc1qtest',
    estimateFee: async () => ({ fee: 245n, feeRate: 2n }),
    estimateMaxSendable: async () => ({ amount: 99000n, fee: 1000n, feeRate: 2n, reserveSats: 0n }),
    approxMaxSpendable: () => 100000n,
    sendToAddress: async () => 'txid123',
    sendMax: async () => 'txid123',
    syncNow: () => {},
    listTransactions: () => [],
    error: null,
    ...overrides,
  }
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
    closeChannel: () => true,
    forceCloseChannel: () => true,
    estimateClose: () => Promise.resolve(null),
    listChannels: () => [],
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

function renderHome(ldkValue?: LdkContextValue, onchainValue?: OnchainContextValue) {
  return render(
    <MemoryRouter>
      <LdkContext value={ldkValue ?? readyLdk()}>
        <OnchainContext value={onchainValue ?? readyOnchain()}>
          <Home />
        </OnchainContext>
      </LdkContext>
    </MemoryRouter>
  )
}

describe('Home', () => {
  it('shows loading shimmer when wallet is loading', () => {
    renderHome(defaultLdkContextValue, defaultOnchainContextValue)
    // Balance area shows a pulse/shimmer placeholder instead of a number
    expect(screen.queryByText(/₿/)).not.toBeInTheDocument()
    // Send/Request buttons are still visible
    expect(screen.getByText(/send/i)).toBeInTheDocument()
  })

  it('shows error state when onchain fails', () => {
    renderHome(readyLdk(), { status: 'error', balance: null, error: new Error('BDK failed') })
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument()
    expect(screen.getByText(/bdk failed/i)).toBeInTheDocument()
  })

  it('shows matching zero dollar and bitcoin values before dollars are allocated', () => {
    renderHome(
      readyLdk(),
      readyOnchain({
        balance: { confirmed: 100000n, trustedPending: 5000n, untrustedPending: 0n },
      })
    )
    expect(
      within(screen.getByRole('group', { name: 'Dollar balance' })).getByText('$0.00')
    ).toBeVisible()
    expect(
      within(screen.getByRole('group', { name: 'Bitcoin equivalent' })).getByText('₿0')
    ).toBeVisible()
    expect(screen.getByRole('link', { name: 'Set up dollars' })).toHaveAttribute(
      'href',
      '/settings/stable-balance'
    )
  })

  it('shows untrusted pending as secondary indicator', () => {
    renderHome(
      readyLdk(),
      readyOnchain({
        balance: { confirmed: 100000n, trustedPending: 0n, untrustedPending: 500n },
      })
    )
    expect(screen.getByText('On-chain deposit pending: ₿500')).toBeInTheDocument()
  })
  it('shows conversion progress without a separate setup step after the first receive', () => {
    stable.state = {
      ...stable.state!,
      enabled: true,
      firstReceive: {
        paymentHashes: ['a'.repeat(64)],
        received: { paymentId: 'a'.repeat(64), channelId, amountSats: '50000' },
        attempted: false,
      },
    }
    stable.status = 'Converting your first payment to dollars'
    renderHome(readyLdk(), readyOnchain())
    expect(screen.getByText(stable.status)).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Set up dollars' })).not.toBeInTheDocument()
    expect(
      within(screen.getByRole('group', { name: 'Dollar balance' })).getByText('$0.00')
    ).toBeVisible()
  })

  it('has Send and Request buttons', () => {
    renderHome()
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /request/i })).toBeInTheDocument()
  })

  it('can toggle balance visibility', async () => {
    const user = userEvent.setup()
    renderHome()
    expect(screen.getByText('₿0')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /hide balance/i }))
    expect(screen.queryByText('₿0')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /show balance/i }))
    expect(screen.getByText('₿0')).toBeInTheDocument()
  })

  it('shows zero balance for new wallet', () => {
    renderHome(
      readyLdk(),
      readyOnchain({
        balance: { confirmed: 0n, trustedPending: 0n, untrustedPending: 0n },
      })
    )
    expect(screen.getByText('₿0')).toBeInTheDocument()
  })

  it('does not add unallocated on-chain or Lightning funds to the dollar equivalent', () => {
    renderHome(
      readyLdk({ lightningBalanceSats: 50_000n }),
      readyOnchain({ balance: { confirmed: 100_000n, trustedPending: 0n, untrustedPending: 0n } })
    )
    expect(screen.getByText('₿0')).toBeInTheDocument()
  })

  it('does not show onchain/lightning breakdown on home screen', () => {
    renderHome(
      readyLdk({ lightningBalanceSats: 50_000n }),
      readyOnchain({ balance: { confirmed: 100_000n, trustedPending: 0n, untrustedPending: 0n } })
    )
    expect(screen.queryByText(/onchain/)).not.toBeInTheDocument()
    expect(screen.queryByText(/lightning/)).not.toBeInTheDocument()
  })
  it('shows the dollar balance in bitcoin at the current price, excluding separate funds', () => {
    allocatedDollars()
    renderHome(
      readyLdk({ lightningBalanceSats: 200000n }),
      readyOnchain({ balance: { confirmed: 50000n, trustedPending: 0n, untrustedPending: 0n } })
    )
    expect(
      within(screen.getByRole('group', { name: 'Dollar balance' })).getByText('$100.00')
    ).toBeVisible()
    expect(screen.queryByText(/Current backing value/)).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Awaiting provider settlement')
    expect(
      within(screen.getByRole('group', { name: 'Bitcoin equivalent' })).getByText('₿101,010')
    ).toBeVisible()
    expect(screen.queryByText('₿250,000')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Manage dollar balance' })).toHaveAttribute(
      'href',
      '/settings/stable-balance'
    )
  })
  it.each(['stale', 'missing', 'invalid'] as const)(
    'does not substitute wallet bitcoin for the equivalent when the price is %s',
    (condition) => {
      allocatedDollars()
      if (condition === 'stale') stable.priceFresh = false
      if (condition === 'missing') stable.price = null
      if (condition === 'invalid') stable.price = { ...stable.price!, priceCents: 0n }
      renderHome(readyLdk({ lightningBalanceSats: 200000n }))
      expect(screen.getByText('$100.00')).toBeVisible()
      expect(
        within(screen.getByRole('group', { name: 'Bitcoin equivalent' })).getByText('Unavailable')
      ).toBeVisible()
      expect(screen.queryByText('₿300,000')).not.toBeInTheDocument()
    }
  )
  it('updates the bitcoin equivalent as prices change while keeping the dollar target fixed', () => {
    allocatedDollars()
    const ldk = readyLdk({ lightningBalanceSats: 200000n })
    const onchain = readyOnchain()
    const view = renderHome(ldk, onchain)
    expect(screen.getByText('₿101,010')).toBeVisible()
    stable.price = { ...stable.price!, priceCents: 10_000_000n }
    view.rerender(
      <MemoryRouter>
        <LdkContext value={ldk}>
          <OnchainContext value={onchain}>
            <Home />
          </OnchainContext>
        </LdkContext>
      </MemoryRouter>
    )
    expect(screen.getByText('$100.00')).toBeVisible()
    expect(screen.getByText('₿100,000')).toBeVisible()
    expect(screen.queryByText('₿101,010')).not.toBeInTheDocument()
  })
  it('shows the full dollar equivalent even when backing includes a channel reserve', () => {
    allocatedDollars()
    stable.state!.position = { ...stable.state!.position!, targetUsd: 4.95, backingSats: '4950' }
    stable.channel = { ...stable.channel!, receiverSats: 4950n, spendableSats: 3950n }
    stable.status = 'Active'
    renderHome(
      readyLdk({ lightningBalanceSats: 3950n }),
      readyOnchain({
        balance: { confirmed: 0n, trustedPending: 0n, untrustedPending: 0n },
      })
    )
    expect(
      within(screen.getByRole('group', { name: 'Dollar balance' })).getByText('$4.95')
    ).toBeVisible()
    expect(
      within(screen.getByRole('group', { name: 'Bitcoin equivalent' })).getByText('₿5,000')
    ).toBeVisible()
    expect(screen.queryByText('Bitcoin total')).not.toBeInTheDocument()
    expect(screen.queryByText('Dollar balance')).not.toBeInTheDocument()
    expect(screen.queryByText('Active')).not.toBeInTheDocument()
    expect(screen.queryByText('Bitcoin')).not.toBeInTheDocument()
  })
  it('shows an unavailable equivalent while dollar recovery fails', () => {
    stable = { ...stable, state: null, error: 'Backup offline' }
    renderHome()
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
    expect(screen.getByText('Dollar balance unavailable')).toBeVisible()
    expect(screen.queryByText('Bitcoin total')).not.toBeInTheDocument()
    expect(
      within(screen.getByRole('group', { name: 'Bitcoin equivalent' })).getByText('Unavailable')
    ).toBeVisible()
    expect(screen.getByText(/Retrying automatically/)).toBeVisible()
  })
  it('shows matching zero values after the dollar channel closes', () => {
    allocatedDollars()
    stable = { ...stable, channel: null, status: 'Previous stable channel is closed' }
    renderHome()
    expect(
      within(screen.getByRole('group', { name: 'Dollar balance' })).getByText('$0.00')
    ).toBeVisible()
    expect(
      within(screen.getByRole('group', { name: 'Bitcoin equivalent' })).getByText('₿0')
    ).toBeVisible()
    expect(screen.queryByText('$100.00')).not.toBeInTheDocument()
    expect(screen.queryByText(/Current backing value/)).not.toBeInTheDocument()
  })
  it('keeps the price equivalent separate from backing reconciliation', () => {
    allocatedDollars()
    stable = {
      ...stable,
      channel: { ...stable.channel!, receiverSats: 90000n },
      status: 'Awaiting provider balance reconciliation',
    }
    renderHome(readyLdk({ lightningBalanceSats: 200000n }))
    expect(screen.getByText('$100.00')).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Awaiting provider balance reconciliation')
    expect(
      within(screen.getByRole('group', { name: 'Bitcoin equivalent' })).getByText('₿101,010')
    ).toBeVisible()
  })
})
