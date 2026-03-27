import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, vi } from 'vitest'
import {
  OnchainContext,
  type OnchainContextValue,
  defaultOnchainContextValue,
} from '../onchain/onchain-context'
import { LdkContext, defaultLdkContextValue, type LdkContextValue } from '../ldk/ldk-context'
import { Send } from './Send'

vi.mock('../ldk/payment-input', () => ({
  classifyPaymentInput: (raw: string) => {
    // BOLT 11 with amount
    if (raw === 'lntbs_with_amount') {
      return {
        type: 'bolt11',
        invoice: {} as never,
        raw,
        amountMsat: 50_000_000n,
        description: 'Test invoice',
      }
    }
    // BOLT 11 without amount
    if (raw === 'lntbs_no_amount') {
      return {
        type: 'bolt11',
        invoice: {} as never,
        raw,
        amountMsat: null,
        description: 'Amountless invoice',
      }
    }
    // BIP 321 with amount
    if (raw.startsWith('bitcoin:') && raw.includes('amount=')) {
      return { type: 'onchain', address: 'tb1qtest', amountSats: 5000n }
    }
    // Invalid lightning
    if (raw.startsWith('lntbs')) {
      return { type: 'error', message: 'Invalid Lightning invoice' }
    }
    // Plain on-chain address
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
    bdkWallet: {} as never,
    bdkEsploraClient: {} as never,
    setSyncNeeded: vi.fn(),
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
    createInvoice: vi.fn(() => 'lnbc1test'),
    channelChangeCounter: 0,
    paymentHistory: [],
    bolt12Offer: null,
    vssStatus: 'ok' as const,
    shutdown: () => {},
  }
  return render(
    <MemoryRouter>
      <LdkContext value={lk}>
        <OnchainContext value={oc}>
          <Send />
        </OnchainContext>
      </LdkContext>
    </MemoryRouter>
  )
}

function readyContext(
  overrides?: Partial<Extract<OnchainContextValue, { status: 'ready' }>>
): OnchainContextValue {
  return {
    status: 'ready',
    balance: { confirmed: 50000n, trustedPending: 0n, untrustedPending: 0n },
    generateAddress: () => 'tb1qtest',
    estimateFee: vi.fn().mockResolvedValue({ fee: 150n, feeRate: 1n }),
    estimateMaxSendable: vi.fn().mockResolvedValue({ amount: 49850n, fee: 150n, feeRate: 1n }),
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

/** Enter a recipient on the first screen and submit. For no-amount inputs, this will show the numpad. */
async function submitRecipient(user: ReturnType<typeof userEvent.setup>, input: string) {
  const recipientInput = screen.getByLabelText(/recipient/i)
  await user.type(recipientInput, input)
  await user.click(screen.getByRole('button', { name: /next/i }))
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

  it('shows recipient screen as first step when ready', () => {
    renderSend(readyContext())
    expect(screen.getByLabelText(/recipient/i)).toBeInTheDocument()
  })

  it('shows recipient placeholder text', () => {
    renderSend(readyContext())
    expect(screen.getByPlaceholderText('payment request or user@domain')).toBeInTheDocument()
  })

  it('disables Next when recipient is empty', () => {
    renderSend(readyContext())
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()
  })

  describe('on-chain flow (no embedded amount)', () => {
    it('shows numpad after entering a plain address', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'tb1qtest')

      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })
    })

    it('displays entered amount in BIP 177 format on numpad', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'tb1qtest')
      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })

      await typeOnNumpad(user, '12345')
      expect(screen.getByText('₿12,345')).toBeInTheDocument()
    })

    it('handles backspace on numpad', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'tb1qtest')
      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })

      await typeOnNumpad(user, '123')
      expect(screen.getByText('₿123')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: /delete/i }))
      expect(screen.getByText('₿12')).toBeInTheDocument()
    })

    it('displays review with correct values after numpad', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'tb1qtest')
      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })

      await typeOnNumpad(user, '10000')
      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      await user.click(nextBtns[nextBtns.length - 1]!)

      await waitFor(() => {
        expect(screen.getByText(/review/i)).toBeInTheDocument()
      })
      expect(screen.getByText('₿10,000')).toBeInTheDocument()
      expect(screen.getByText('₿150')).toBeInTheDocument()
      expect(screen.getByText('₿10,150')).toBeInTheDocument()
    })

    it('goes back to numpad from review (amount was manually entered)', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'tb1qtest')
      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })

      await typeOnNumpad(user, '10000')
      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      await user.click(nextBtns[nextBtns.length - 1]!)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /back/i }))
      // Should be back on numpad (amount screen)
      expect(screen.getByText(/available/i)).toBeInTheDocument()
    })

    it('goes back to recipient from numpad with input preserved', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'tb1qtest')
      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /back/i }))
      expect(screen.getByLabelText(/recipient/i)).toBeInTheDocument()
    })

    it('shows success after confirm', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'tb1qtest')
      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })

      await typeOnNumpad(user, '10000')
      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      await user.click(nextBtns[nextBtns.length - 1]!)

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

      await submitRecipient(user, 'tb1qtest')
      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })

      await typeOnNumpad(user, '10000')
      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      await user.click(nextBtns[nextBtns.length - 1]!)

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

      await submitRecipient(user, 'tb1qtest')
      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })

      await typeOnNumpad(user, '100')
      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      await user.click(nextBtns[nextBtns.length - 1]!)

      await waitFor(() => {
        expect(screen.getByText(/at least 294 sats/i)).toBeInTheDocument()
      })
    })
  })

  describe('on-chain flow (BIP 321 with embedded amount)', () => {
    it('skips numpad and goes straight to review', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'bitcoin:tb1qtest?amount=0.00005')

      await waitFor(() => {
        expect(screen.getByText(/review/i)).toBeInTheDocument()
      })
      expect(screen.getByText('₿5,000')).toBeInTheDocument()
    })

    it('goes back to recipient from review (not numpad)', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'bitcoin:tb1qtest?amount=0.00005')

      await waitFor(() => {
        expect(screen.getByText(/review/i)).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /back/i }))
      expect(screen.getByLabelText(/recipient/i)).toBeInTheDocument()
    })
  })

  describe('lightning flow (fixed amount)', () => {
    it('skips numpad and goes to ln-review for bolt11 with amount', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'lntbs_with_amount')

      await waitFor(() => {
        expect(screen.getByText(/review/i)).toBeInTheDocument()
      })
      expect(screen.getByText('₿50,000')).toBeInTheDocument()
    })

    it('goes back to recipient from ln-review (amount was embedded)', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'lntbs_with_amount')

      await waitFor(() => {
        expect(screen.getByText(/review/i)).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /back/i }))
      expect(screen.getByLabelText(/recipient/i)).toBeInTheDocument()
    })
  })

  describe('lightning flow (no amount)', () => {
    it('shows numpad for amountless bolt11', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'lntbs_no_amount')

      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })
    })

    it('goes to ln-review after entering amount on numpad', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'lntbs_no_amount')
      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })

      await typeOnNumpad(user, '5000')
      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      await user.click(nextBtns[nextBtns.length - 1]!)

      await waitFor(() => {
        expect(screen.getByText(/review/i)).toBeInTheDocument()
      })
    })
  })

  describe('insufficient balance', () => {
    it('shows error when on-chain amount exceeds balance', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'tb1qtest')
      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })

      await typeOnNumpad(user, '99999999')
      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      await user.click(nextBtns[nextBtns.length - 1]!)

      await waitFor(() => {
        expect(screen.getByText(/exceeds available on-chain balance/i)).toBeInTheDocument()
      })
    })

    it('shows error when bolt11 amount exceeds lightning capacity', async () => {
      const user = userEvent.setup()
      renderSend(readyContext(), {
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
        sendBolt11Payment: vi.fn(),
        sendBolt12Payment: vi.fn(),

        closeChannel: vi.fn(),
        forceCloseChannel: vi.fn(),
        listChannels: vi.fn(() => []),
        abandonPayment: vi.fn(),
        getPaymentResult: vi.fn(() => null),
        listRecentPayments: vi.fn(() => []),
        outboundCapacityMsat: vi.fn(() => 1000n), // Very low capacity
        lightningBalanceSats: 1n,
        createInvoice: vi.fn(() => 'lnbc1test'),
        channelChangeCounter: 0,
        paymentHistory: [],
        bolt12Offer: null,
        vssStatus: 'ok' as const,
        shutdown: () => {},
      })

      await submitRecipient(user, 'lntbs_with_amount')

      await waitFor(() => {
        expect(screen.getByText(/exceeds Lightning channel capacity/i)).toBeInTheDocument()
      })
    })
  })

  describe('error retry', () => {
    it('returns to review screen on retry', async () => {
      const user = userEvent.setup()
      const ctx = readyContext({
        sendToAddress: vi.fn().mockRejectedValue(new Error('Broadcast failed')),
      })
      renderSend(ctx)

      await submitRecipient(user, 'tb1qtest')
      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })

      await typeOnNumpad(user, '10000')
      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      await user.click(nextBtns[nextBtns.length - 1]!)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /confirm send/i })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /confirm send/i }))

      await waitFor(() => {
        expect(screen.getByText(/send failed/i)).toBeInTheDocument()
      })

      // Click "Try Again" — should return to review, not recipient
      await user.click(screen.getByRole('button', { name: /try again/i }))

      await waitFor(() => {
        expect(screen.getByText(/review/i)).toBeInTheDocument()
      })
      expect(screen.getByText('₿10,000')).toBeInTheDocument()
    })
  })
})
