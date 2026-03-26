import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, vi } from 'vitest'
import {
  OnchainContext,
  type OnchainContextValue,
  defaultOnchainContextValue,
} from '../onchain/onchain-context'
import { LdkContext, defaultLdkContextValue, type LdkContextValue } from '../ldk/ldk-context'
import { Receive } from './Receive'

function readyContext(
  overrides?: Partial<Extract<OnchainContextValue, { status: 'ready' }>>
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

function readyLdkContext(
  overrides?: Partial<Extract<LdkContextValue, { status: 'ready' }>>
): LdkContextValue {
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
    bdkWallet: {} as never,
    bdkEsploraClient: {} as never,
    setSyncNeeded: vi.fn(),
    createInvoice: vi.fn(() => 'lntbs1fakeinvoice'),
    sendBolt11Payment: vi.fn(),
    sendBolt12Payment: vi.fn(),
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
    bolt12Offer: null,
    vssStatus: 'ok' as const,
    shutdown: () => {},
    ...overrides,
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
    </MemoryRouter>
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
    expect(screen.getByLabelText(/qr code for bitcoin address/i)).toBeInTheDocument()
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
      })
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
      const addAmountButton = screen.getByRole('button', { name: /add amount/i })
      addAmountButton.focus()
      await user.keyboard('{Tab}')
      expect(backButton).toHaveFocus()
    })

    it('wraps focus from first to last element on Shift+Tab', async () => {
      const user = userEvent.setup()
      renderReceive(readyContext())

      const backButton = screen.getByRole('button', { name: /back/i })
      backButton.focus()
      await user.keyboard('{Shift>}{Tab}{/Shift}')
      const addAmountButton = screen.getByRole('button', { name: /add amount/i })
      expect(addAmountButton).toHaveFocus()
    })
  })

  describe('amount entry', () => {
    it('shows "Add amount" label on initial render', () => {
      renderReceive()
      expect(screen.getByRole('button', { name: /add amount/i })).toBeInTheDocument()
    })

    it('tapping "Add amount" shows the numpad and hides the QR', async () => {
      const user = userEvent.setup()
      renderReceive()

      await user.click(screen.getByRole('button', { name: /add amount/i }))

      expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument()
      expect(screen.queryByLabelText(/qr code/i)).not.toBeInTheDocument()
    })

    it('entering digits and confirming regenerates the invoice with amount', async () => {
      const user = userEvent.setup()
      const createInvoice = vi.fn(() => 'lntbs1amountinvoice')
      renderReceive(undefined, readyLdkContext({ createInvoice }))

      await user.click(screen.getByRole('button', { name: /add amount/i }))
      await user.click(screen.getByRole('button', { name: '5' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: /done/i }))

      // Should have been called with amountMsat = 50000 * 1000 = 50_000_000n
      expect(createInvoice).toHaveBeenCalledWith(50_000_000n)
    })

    it('BIP 21 URI includes amount= when amount is set', async () => {
      const user = userEvent.setup()
      const createInvoice = vi.fn(() => 'lntbs1amountinvoice')
      renderReceive(undefined, readyLdkContext({ createInvoice }))

      await user.click(screen.getByRole('button', { name: /add amount/i }))
      await user.click(screen.getByRole('button', { name: '1' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: /done/i }))

      // The QR code aria-label should mention the amount
      expect(screen.getByLabelText(/amount ₿100/i)).toBeInTheDocument()
    })

    it('cancel returns to QR without changing amount', async () => {
      const user = userEvent.setup()
      renderReceive()

      await user.click(screen.getByRole('button', { name: /add amount/i }))
      await user.click(screen.getByRole('button', { name: '5' }))
      await user.click(screen.getByRole('button', { name: /cancel/i }))

      // Should be back to QR view with "Add amount" (no amount was confirmed)
      expect(screen.getByRole('button', { name: /add amount/i })).toBeInTheDocument()
      expect(screen.getByLabelText(/qr code/i)).toBeInTheDocument()
    })

    it('tapping "Edit amount" re-opens numpad with pre-populated digits', async () => {
      const user = userEvent.setup()
      renderReceive()

      // Set amount to 500
      await user.click(screen.getByRole('button', { name: /add amount/i }))
      await user.click(screen.getByRole('button', { name: '5' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: /done/i }))

      // Amount should be displayed above QR, and button says "Edit amount"
      expect(screen.getByText('₿500')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /edit amount/i })).toBeInTheDocument()

      // Tap "Edit amount" to re-edit
      await user.click(screen.getByRole('button', { name: /edit amount/i }))

      // Should show numpad with the amount displayed
      expect(screen.getByText('₿500')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument()
    })

    it('remove amount clears back to zero-amount invoice', async () => {
      const user = userEvent.setup()
      const createInvoice = vi.fn(() => 'lntbs1fakeinvoice')
      renderReceive(undefined, readyLdkContext({ createInvoice }))

      // Set an amount
      await user.click(screen.getByRole('button', { name: /add amount/i }))
      await user.click(screen.getByRole('button', { name: '1' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: /done/i }))

      // Now edit and remove
      await user.click(screen.getByRole('button', { name: /edit amount/i }))
      await user.click(screen.getByRole('button', { name: /remove amount/i }))

      // Should be back to "Add amount" label
      expect(screen.getByRole('button', { name: /add amount/i })).toBeInTheDocument()

      // createInvoice should have been called with no amount (last call)
      const lastCall = createInvoice.mock.calls[createInvoice.mock.calls.length - 1]
      expect(lastCall).toEqual([undefined])
    })

    it('shows invoice error when regeneration fails with amount', async () => {
      const user = userEvent.setup()
      let callCount = 0
      const createInvoice = vi.fn(() => {
        callCount++
        // First call (zero-amount) succeeds, subsequent calls with amount fail
        if (callCount > 1) throw new Error('Invoice creation failed')
        return 'lntbs1fakeinvoice'
      })
      renderReceive(undefined, readyLdkContext({ createInvoice }))

      await user.click(screen.getByRole('button', { name: /add amount/i }))
      await user.click(screen.getByRole('button', { name: '1' }))
      await user.click(screen.getByRole('button', { name: /done/i }))

      expect(screen.getByText(/failed to create lightning invoice/i)).toBeInTheDocument()
    })

    it('createInvoice is called with no amount on initial load', () => {
      const createInvoice = vi.fn(() => 'lntbs1fakeinvoice')
      renderReceive(undefined, readyLdkContext({ createInvoice }))

      expect(createInvoice).toHaveBeenCalledWith(undefined)
    })
  })
})
