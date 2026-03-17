import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, vi } from 'vitest'
import {
  OnchainContext,
  type OnchainContextValue,
  defaultOnchainContextValue,
} from '../onchain/onchain-context'
import {
  LdkContext,
  defaultLdkContextValue,
  type LdkContextValue,
} from '../ldk/ldk-context'
import { Receive } from './Receive'

function readyContext(
  overrides?: Partial<Extract<OnchainContextValue, { status: 'ready' }>>,
): OnchainContextValue {
  return {
    status: 'ready',
    balance: { confirmed: 50000n, trustedPending: 0n, untrustedPending: 0n },
    generateAddress: () => 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
    estimateFee: vi.fn().mockResolvedValue({ fee: 150n, feeRate: 1n }),
    estimateMaxSendable: vi.fn().mockResolvedValue({ amount: 49850n, fee: 150n, feeRate: 1n }),
    sendToAddress: vi.fn().mockResolvedValue('txid123'),
    sendMax: vi.fn().mockResolvedValue('txid123'),
    syncNow: vi.fn(),
    listTransactions: () => [],
    error: null,
    ...overrides,
  }
}

function readyLdkContext(): LdkContextValue {
  return {
    ...defaultLdkContextValue,
    status: 'ready' as const,
    node: {} as never,
    nodeId: 'test',
    error: null,
    syncStatus: 'synced' as const,
    peersReconnected: true,
    connectToPeer: vi.fn(),
    forgetPeer: vi.fn(),
    createChannel: vi.fn(),
    setBdkWallet: vi.fn(),
    setSyncNeeded: vi.fn(),
    createInvoice: vi.fn(() => 'lntbs1fakeinvoice'),
    sendBolt11Payment: vi.fn(),
    sendBolt12Payment: vi.fn(),
    sendBip353Payment: vi.fn(),
    closeChannel: vi.fn(),
    forceCloseChannel: vi.fn(),
    listChannels: vi.fn(() => []),
    abandonPayment: vi.fn(),
    getPaymentResult: vi.fn(() => null),
    listRecentPayments: vi.fn(() => []),
    outboundCapacityMsat: vi.fn(() => 1_000_000_000n),
    lightningBalanceSats: 1_000_000n,
    channelChangeCounter: 0,
    paymentHistory: [],
  }
}

function renderReceive(contextValue?: OnchainContextValue, ldkValue?: LdkContextValue) {
  return render(
    <MemoryRouter>
      <LdkContext value={ldkValue ?? readyLdkContext()}>
        <OnchainContext value={contextValue ?? readyContext()}>
          <Receive />
        </OnchainContext>
      </LdkContext>
    </MemoryRouter>,
  )
}

describe('Receive', () => {
  it('shows loading state', () => {
    renderReceive(defaultOnchainContextValue)
    expect(screen.getByText(/loading wallet/i)).toBeInTheDocument()
  })

  it('shows error state', () => {
    renderReceive({ status: 'error', balance: null, error: new Error('BDK failed') })
    expect(screen.getByText(/failed to load wallet/i)).toBeInTheDocument()
  })

  it('shows QR code when ready', () => {
    renderReceive()
    expect(
      screen.getByLabelText(/qr code for bitcoin address/i),
    ).toBeInTheDocument()
  })

  it('QR code uses uppercase BIP21 URI format', () => {
    renderReceive()
    const qrContainer = screen.getByLabelText(/qr code for bitcoin address/i)
    expect(qrContainer).toBeInTheDocument()
  })

  it('shows error when address generation fails', () => {
    renderReceive(
      readyContext({
        generateAddress: () => {
          throw new Error('BDK not initialized')
        },
      }),
    )
    expect(screen.getByText(/BDK not initialized/)).toBeInTheDocument()
  })

  it('shows truncated address', () => {
    renderReceive()
    expect(screen.getByText(/bitcoin:tb1qw508\.\.\.xpjzsx/)).toBeInTheDocument()
  })

  it('shows Request heading', () => {
    renderReceive()
    expect(screen.getByText('Request')).toBeInTheDocument()
  })

  it('has a back button', () => {
    renderReceive()
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument()
  })

  it('has a copy button', () => {
    renderReceive()
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument()
  })

  describe('focus trap', () => {
    it('focuses the first focusable element on mount', () => {
      renderReceive(readyContext())
      const backButton = screen.getByRole('button', { name: /back/i })
      expect(backButton).toHaveFocus()
    })

    it('wraps focus from last to first element on Tab', async () => {
      const user = userEvent.setup()
      renderReceive(readyContext())

      const backButton = screen.getByRole('button', { name: /back/i })
      const copyButton = screen.getByRole('button', { name: /copy/i })
      copyButton.focus()
      await user.keyboard('{Tab}')
      expect(backButton).toHaveFocus()
    })

    it('wraps focus from first to last element on Shift+Tab', async () => {
      const user = userEvent.setup()
      renderReceive(readyContext())

      const backButton = screen.getByRole('button', { name: /back/i })
      backButton.focus()
      await user.keyboard('{Shift>}{Tab}{/Shift}')
      const copyButton = screen.getByRole('button', { name: /copy/i })
      expect(copyButton).toHaveFocus()
    })
  })
})
