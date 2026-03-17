import { render, screen, waitFor } from '@testing-library/react'
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
import { Send } from './Send'

vi.mock('../ldk/payment-input', () => ({
  classifyPaymentInput: (raw: string) => {
    if (raw.startsWith('lntbs')) {
      return { type: 'error', message: 'Invalid Lightning invoice' }
    }
    return { type: 'onchain', address: raw, amountSats: null }
  },
}))

function renderSend(onchainValue?: OnchainContextValue, ldkValue?: LdkContextValue) {
  const oc = onchainValue ?? defaultOnchainContextValue
  const lk = ldkValue ?? {
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
    createInvoice: vi.fn(() => 'lnbc1test'),
    channelChangeCounter: 0,
    paymentHistory: [],
  }
  return render(
    <MemoryRouter>
      <LdkContext value={lk}>
        <OnchainContext value={oc}>
          <Send />
        </OnchainContext>
      </LdkContext>
    </MemoryRouter>,
  )
}

function readyContext(
  overrides?: Partial<Extract<OnchainContextValue, { status: 'ready' }>>,
): OnchainContextValue {
  return {
    status: 'ready',
    balance: { confirmed: 50000n, trustedPending: 0n, untrustedPending: 0n },
    generateAddress: () => 'tb1qtest',
    estimateFee: vi.fn().mockResolvedValue({ fee: 150n, feeRate: 1n }),
    estimateMaxSendable: vi
      .fn()
      .mockResolvedValue({ amount: 49850n, fee: 150n, feeRate: 1n }),
    sendToAddress: vi.fn().mockResolvedValue('abc123txid'),
    sendMax: vi.fn().mockResolvedValue('maxabc123txid'),
    syncNow: vi.fn(),
    listTransactions: () => [],
    error: null,
    ...overrides,
  }
}

async function typeOnNumpad(user: ReturnType<typeof userEvent.setup>, digits: string) {
  for (const d of digits) {
    await user.click(screen.getByRole('button', { name: d }))
  }
}

async function goToRecipientScreen(user: ReturnType<typeof userEvent.setup>, amount = '10000') {
  await typeOnNumpad(user, amount)
  const nextBtns = screen.getAllByRole('button', { name: /next/i })
  await user.click(nextBtns[nextBtns.length - 1]!)
  await waitFor(() => {
    expect(screen.getByLabelText(/recipient/i)).toBeInTheDocument()
  })
}

describe('Send', () => {
  it('shows loading state when onchain is loading', () => {
    renderSend()
    expect(screen.getByText(/loading wallet/i)).toBeInTheDocument()
  })

  it('shows error state', () => {
    renderSend({
      status: 'error',
      balance: null,
      error: new Error('BDK init failed'),
    })
    expect(screen.getByText(/failed to load wallet/i)).toBeInTheDocument()
    expect(screen.getByText(/bdk init failed/i)).toBeInTheDocument()
  })

  it('shows numpad (amount screen) when ready', () => {
    renderSend(readyContext())
    expect(screen.getByText(/available/i)).toBeInTheDocument()
  })

  it('shows Next disabled when amount is zero', () => {
    renderSend(readyContext())
    const nextBtns = screen.getAllByRole('button', { name: /next/i })
    const numpadNext = nextBtns[nextBtns.length - 1]!
    expect(numpadNext).toBeDisabled()
  })

  describe('on-chain flow', () => {
    it('navigates to recipient screen after entering amount', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await typeOnNumpad(user, '10000')
      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      await user.click(nextBtns[nextBtns.length - 1]!)

      await waitFor(() => {
        expect(screen.getByLabelText(/recipient/i)).toBeInTheDocument()
      })
    })

    it('displays entered amount in BIP 177 format', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await typeOnNumpad(user, '12345')
      expect(screen.getByText('₿12,345')).toBeInTheDocument()
    })

    it('shows recipient placeholder text', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())
      await goToRecipientScreen(user)

      expect(screen.getByPlaceholderText('payment request or user@domain')).toBeInTheDocument()
    })

    it('handles backspace on numpad', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await typeOnNumpad(user, '123')
      expect(screen.getByText('₿123')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: /delete/i }))
      expect(screen.getByText('₿12')).toBeInTheDocument()
    })

    it('displays review with correct values', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())
      await goToRecipientScreen(user)

      await user.type(screen.getByLabelText(/recipient/i), 'tb1qtest')
      await user.click(screen.getByRole('button', { name: /next/i }))

      await waitFor(() => {
        expect(screen.getByText(/review/i)).toBeInTheDocument()
      })
      expect(screen.getByText('₿10,000')).toBeInTheDocument()
      expect(screen.getByText('₿150')).toBeInTheDocument()
      expect(screen.getByText('₿10,150')).toBeInTheDocument()
    })

    it('goes back to recipient from review', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())
      await goToRecipientScreen(user)

      await user.type(screen.getByLabelText(/recipient/i), 'tb1qtest')
      await user.click(screen.getByRole('button', { name: /next/i }))

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /back/i }))
      expect(screen.getByLabelText(/recipient/i)).toBeInTheDocument()
    })

    it('shows success after confirm', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())
      await goToRecipientScreen(user)

      await user.type(screen.getByLabelText(/recipient/i), 'tb1qtest')
      await user.click(screen.getByRole('button', { name: /next/i }))

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /confirm send/i })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /confirm send/i }))

      await waitFor(() => {
        expect(screen.getByText(/sent successfully/i)).toBeInTheDocument()
      })
    })

    it('shows error on broadcast failure', async () => {
      const user = userEvent.setup()
      const ctx = readyContext({
        sendToAddress: vi.fn().mockRejectedValue(new Error('Broadcast failed')),
      })
      renderSend(ctx)
      await goToRecipientScreen(user)

      await user.type(screen.getByLabelText(/recipient/i), 'tb1qtest')
      await user.click(screen.getByRole('button', { name: /next/i }))

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /confirm send/i })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /confirm send/i }))

      await waitFor(() => {
        expect(screen.getByText(/send failed/i)).toBeInTheDocument()
      })
      expect(screen.getByText(/broadcast failed/i)).toBeInTheDocument()
      expect(screen.getByText(/your funds are safe/i)).toBeInTheDocument()
    })

    it('shows error for dust amount on recipient screen', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())
      await goToRecipientScreen(user, '100')

      await user.type(screen.getByLabelText(/recipient/i), 'tb1qtest')
      await user.click(screen.getByRole('button', { name: /next/i }))

      await waitFor(() => {
        expect(screen.getByText(/at least 294 sats/i)).toBeInTheDocument()
      })
    })

    it('preserves amount when navigating back from recipient', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await typeOnNumpad(user, '5000')
      expect(screen.getByText('₿5,000')).toBeInTheDocument()

      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      await user.click(nextBtns[nextBtns.length - 1]!)

      await waitFor(() => {
        expect(screen.getByLabelText(/recipient/i)).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /back/i }))

      expect(screen.getByText('₿5,000')).toBeInTheDocument()
    })
  })
})
