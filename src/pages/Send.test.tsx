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
    connectToPeer: vi.fn(),
    forgetPeer: vi.fn(),
    createChannel: vi.fn(),
    setBdkWallet: vi.fn(),
    sendBolt11Payment: vi.fn(),
    sendBolt12Payment: vi.fn(),
    sendBip353Payment: vi.fn(),
    abandonPayment: vi.fn(),
    getPaymentResult: vi.fn(() => null),
    listRecentPayments: vi.fn(() => []),
    outboundCapacityMsat: vi.fn(() => 1_000_000_000n),
    lightningBalanceSats: 1_000_000n,
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
    error: null,
    ...overrides,
  }
}

async function goToAmountScreen(user: ReturnType<typeof userEvent.setup>, address = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx') {
  await user.type(screen.getByLabelText(/recipient/i), address)
  await user.click(screen.getByRole('button', { name: /next/i }))
  await waitFor(() => {
    expect(screen.getByText(/available/i)).toBeInTheDocument()
  })
}

async function typeOnNumpad(user: ReturnType<typeof userEvent.setup>, digits: string) {
  for (const d of digits) {
    await user.click(screen.getByRole('button', { name: d }))
  }
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

  it('shows unified input when ready', () => {
    renderSend(readyContext())
    expect(screen.getByLabelText(/recipient/i)).toBeInTheDocument()
  })

  it('shows Next disabled when input is empty', () => {
    renderSend(readyContext())
    const button = screen.getByRole('button', { name: /next/i })
    expect(button).toBeDisabled()
  })

  describe('on-chain flow', () => {
    it('navigates to amount screen after entering address', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await user.type(screen.getByLabelText(/recipient/i), 'tb1qtest')
      await user.click(screen.getByRole('button', { name: /next/i }))

      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })
    })

    it('displays entered amount in BIP 177 format', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())
      await goToAmountScreen(user)

      await typeOnNumpad(user, '12345')
      expect(screen.getByText('₿12,345')).toBeInTheDocument()
    })

    it('shows Next disabled when amount is zero', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())
      await goToAmountScreen(user)

      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      const numpadNext = nextBtns[nextBtns.length - 1]
      expect(numpadNext).toBeDisabled()
    })

    it('handles backspace', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())
      await goToAmountScreen(user)

      await typeOnNumpad(user, '123')
      expect(screen.getByText('₿123')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: /delete/i }))
      expect(screen.getByText('₿12')).toBeInTheDocument()
    })

    it('displays review with correct values', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())
      await goToAmountScreen(user)

      await typeOnNumpad(user, '10000')
      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      await user.click(nextBtns[nextBtns.length - 1])

      await waitFor(() => {
        expect(screen.getByText(/review/i)).toBeInTheDocument()
      })
      expect(screen.getByText('₿10,000')).toBeInTheDocument()
      expect(screen.getByText('₿150')).toBeInTheDocument()
      expect(screen.getByText('₿10,150')).toBeInTheDocument()
    })

    it('goes back to amount from review', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())
      await goToAmountScreen(user)

      await typeOnNumpad(user, '10000')
      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      await user.click(nextBtns[nextBtns.length - 1])

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /back/i }))
      expect(screen.getByText(/available/i)).toBeInTheDocument()
    })

    it('shows success after confirm', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())
      await goToAmountScreen(user)

      await typeOnNumpad(user, '10000')
      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      await user.click(nextBtns[nextBtns.length - 1])

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
      await goToAmountScreen(user)

      await typeOnNumpad(user, '10000')
      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      await user.click(nextBtns[nextBtns.length - 1])

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

    it('shows error for dust amount', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())
      await goToAmountScreen(user)

      await typeOnNumpad(user, '100')
      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      await user.click(nextBtns[nextBtns.length - 1])

      await waitFor(() => {
        expect(screen.getByText(/at least 294 sats/i)).toBeInTheDocument()
      })
    })
  })
})
