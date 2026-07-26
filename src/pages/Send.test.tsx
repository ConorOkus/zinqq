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
    if (raw === 'lnbc_with_amount') {
      return {
        type: 'bolt11',
        invoice: {} as never,
        raw,
        amountMsat: 50_000_000n,
        description: 'Test invoice',
      }
    }
    // BOLT 11 without amount
    if (raw === 'lnbc_no_amount') {
      return {
        type: 'bolt11',
        invoice: {} as never,
        raw,
        amountMsat: null,
        description: 'Amountless invoice',
      }
    }
    // BIP 321 with amountless lightning= invoice
    if (raw.startsWith('bitcoin:') && raw.includes('lightning=lnbc_noamt')) {
      return {
        type: 'bolt11',
        invoice: {} as never,
        raw: 'lnbc_noamt_raw_invoice',
        amountMsat: null,
        description: null,
      }
    }
    // BIP 321 with lightning= invoice
    if (raw.startsWith('bitcoin:') && raw.includes('lightning=')) {
      return {
        type: 'bolt11',
        invoice: {} as never,
        raw: 'lnbc50u1ptest',
        amountMsat: 50_000_000n,
        description: 'BIP 321 embedded invoice',
      }
    }
    // BIP 321 with amount
    if (raw.startsWith('bitcoin:') && raw.includes('amount=')) {
      return { type: 'onchain', address: 'bc1qtest', amountSats: 5000n }
    }
    // Invalid lightning
    if (raw.startsWith('lnbc')) {
      return { type: 'error', message: 'Invalid Lightning invoice' }
    }
    // Plain on-chain address
    return { type: 'onchain', address: raw, amountSats: null }
  },
}))

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
    disconnectPeer: vi.fn(),
    createChannel: vi.fn(),
    bdkWallet: {} as never,
    bdkEsploraClient: {} as never,
    setSyncNeeded: vi.fn(),
    sendBolt11Payment: vi.fn(),
    sendBolt12Payment: vi.fn(),

    closeChannel: vi.fn(),
    forceCloseChannel: vi.fn(),
    estimateClose: vi.fn(() => Promise.resolve(null)),
    listChannels: vi.fn(() => []),
    abandonPayment: vi.fn(),
    getPaymentResult: vi.fn(() => null),
    listRecentPayments: vi.fn(() => []),
    outboundCapacityMsat: vi.fn(() => 1_000_000_000n),
    lightningBalanceSats: 1_000_000n,
    createInvoice: vi.fn(() => ({ bolt11: 'lnbc1test', paymentHash: 'abc123' })),
    requestJitQuote: vi.fn(),
    fetchMinJitReceiveSats: vi.fn(() => Promise.resolve(0n)),
    executeJitBuy: vi.fn(),
    channelChangeCounter: 0,
    paymentHistory: [],
    bolt12Offer: null,
    vssStatus: 'ok' as const,
    vssClient: null,
    shutdown: () => {},
    ...overrides,
  }
}

function renderSend(
  onchainValue?: OnchainContextValue,
  ldkValue?: LdkContextValue,
  initialEntries?: string[] | Array<{ pathname: string; state?: unknown }>
) {
  const oc = onchainValue ?? defaultOnchainContextValue
  const lk = ldkValue ?? readyLdkContext()
  return render(
    <MemoryRouter initialEntries={initialEntries}>
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
    generateAddress: () => 'bc1qtest',
    estimateFee: vi.fn().mockResolvedValue({ fee: 150n, feeRate: 1n }),
    estimateMaxSendable: vi
      .fn()
      .mockResolvedValue({ amount: 49850n, fee: 150n, feeRate: 1n, reserveSats: 0n }),
    approxMaxSpendable: vi.fn(() => 50000n),
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

      await submitRecipient(user, 'bc1qtest')

      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })
    })

    it('displays entered amount in BIP 177 format on numpad', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'bc1qtest')
      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })

      await typeOnNumpad(user, '12345')
      expect(screen.getByText('₿12,345')).toBeInTheDocument()
    })

    it('handles backspace on numpad', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'bc1qtest')
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

      await submitRecipient(user, 'bc1qtest')
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

      await submitRecipient(user, 'bc1qtest')
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

      await submitRecipient(user, 'bc1qtest')
      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /back/i }))
      expect(screen.getByLabelText(/recipient/i)).toBeInTheDocument()
    })

    it('shows success after confirm', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'bc1qtest')
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

      await submitRecipient(user, 'bc1qtest')
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

      await submitRecipient(user, 'bc1qtest')
      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })

      await typeOnNumpad(user, '100')
      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      await user.click(nextBtns[nextBtns.length - 1]!)

      await waitFor(() => {
        expect(screen.getByText(/at least ₿294.*dust limit/i)).toBeInTheDocument()
      })
    })
  })

  describe('on-chain flow (BIP 321 with embedded amount)', () => {
    it('skips numpad and goes straight to review', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'bitcoin:bc1qtest?amount=0.00005')

      await waitFor(() => {
        expect(screen.getByText(/review/i)).toBeInTheDocument()
      })
      expect(screen.getByText('₿5,000')).toBeInTheDocument()
    })

    it('goes back to recipient from review (not numpad)', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'bitcoin:bc1qtest?amount=0.00005')

      await waitFor(() => {
        expect(screen.getByText(/review/i)).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /back/i }))
      expect(screen.getByLabelText(/recipient/i)).toBeInTheDocument()
    })

    it('embedded amount overrides send-all: confirms via sendToAddress, never sendMax', async () => {
      const user = userEvent.setup()
      const ctx = readyContext()
      renderSend(ctx)

      await submitRecipient(user, 'bitcoin:bc1qtest?amount=0.00005')

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /confirm send/i })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /confirm send/i }))

      await waitFor(() => {
        expect(screen.getByText(/sent successfully/i)).toBeInTheDocument()
      })
      if (ctx.status !== 'ready') throw new Error('unreachable')
      expect(ctx.sendToAddress).toHaveBeenCalledWith('bc1qtest', 5000n, 1n)
      expect(ctx.sendMax).not.toHaveBeenCalled()
      expect(ctx.estimateMaxSendable).not.toHaveBeenCalled()
    })
  })

  describe('lightning flow (fixed amount)', () => {
    it('skips numpad and goes to ln-review for bolt11 with amount', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'lnbc_with_amount')

      await waitFor(() => {
        expect(screen.getByText(/review/i)).toBeInTheDocument()
      })
      expect(screen.getByText('₿50,000')).toBeInTheDocument()
    })

    it('goes back to recipient from ln-review (amount was embedded)', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'lnbc_with_amount')

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

      await submitRecipient(user, 'lnbc_no_amount')

      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })
    })

    it('goes to ln-review after entering amount on numpad', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'lnbc_no_amount')
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

      await submitRecipient(user, 'bc1qtest')
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
      renderSend(
        readyContext(),
        readyLdkContext({
          outboundCapacityMsat: vi.fn(() => 1000n),
          lightningBalanceSats: 1n,
        })
      )

      await submitRecipient(user, 'lnbc_with_amount')

      await waitFor(() => {
        expect(screen.getByText(/not enough funds/i)).toBeInTheDocument()
      })
    })

    it('shows first 10 chars of bolt11 in To field for BIP 321 URI', async () => {
      const user = userEvent.setup()
      renderSend(readyContext(), readyLdkContext())

      await submitRecipient(user, 'bitcoin:bc1qtest?lightning=lnbc50u1ptest')

      await waitFor(() => {
        expect(screen.getByText('lnbc50u1pt…')).toBeInTheDocument()
      })
    })

    it('shows truncated invoice in To field for amountless BIP 321 via numpad', async () => {
      const user = userEvent.setup()
      renderSend(readyContext(), readyLdkContext())

      await submitRecipient(user, 'bitcoin:bc1qtest?lightning=lnbc_noamt')
      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })

      await typeOnNumpad(user, '5000')
      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      await user.click(nextBtns[nextBtns.length - 1]!)

      await waitFor(() => {
        expect(screen.getByText('lnbc_noamt…')).toBeInTheDocument()
      })
    })

    it('shows not enough funds for BIP 321 bolt11 exceeding capacity', async () => {
      const user = userEvent.setup()
      renderSend(
        readyContext(),
        readyLdkContext({
          outboundCapacityMsat: vi.fn(() => 1000n),
          lightningBalanceSats: 1n,
        })
      )

      await submitRecipient(user, 'bitcoin:bc1qtest?lightning=lnbc50u1ptest')

      await waitFor(() => {
        expect(screen.getByText(/not enough funds/i)).toBeInTheDocument()
      })
    })
  })

  describe('send all (onchain Max control)', () => {
    it('shows a Max control with the spendable figure for an onchain recipient', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'bc1qtest')
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /max/i })).toBeInTheDocument()
      })
      // Displayed figure is confirmed + trustedPending (50,000), never lightning
      expect(screen.getByRole('button', { name: /max/i })).toHaveTextContent(
        '₿50,000 available · Max'
      )
    })

    it('tapping Max prefills the spendable amount and enters send-all mode (no channels)', async () => {
      const user = userEvent.setup()
      const ctx = readyContext()
      renderSend(ctx)

      await submitRecipient(user, 'bc1qtest')
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /max/i })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /max/i }))
      // Prefill = spendable 50,000, no reserve (no channels) — NOT unified 1,050,000
      expect(screen.getByText('₿50,000')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /max/i })).toHaveAttribute('aria-pressed', 'true')
      if (ctx.status !== 'ready') throw new Error('unreachable')
      expect(ctx.approxMaxSpendable).toHaveBeenCalled()
    })

    it('displays spendable but prefills reserve-adjusted amount when channels are open', async () => {
      const user = userEvent.setup()
      // Spendable 50,000 includes the 10,000 anchor reserve; prefill helper returns 40,000
      const ctx = readyContext({ approxMaxSpendable: vi.fn(() => 40000n) })
      renderSend(ctx)

      await submitRecipient(user, 'bc1qtest')
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /max/i })).toBeInTheDocument()
      })
      expect(screen.getByRole('button', { name: /max/i })).toHaveTextContent(
        '₿50,000 available · Max'
      )

      await user.click(screen.getByRole('button', { name: /max/i }))
      expect(screen.getByText('₿40,000')).toBeInTheDocument()
    })

    it('exits send-all mode on any numpad keypress', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'bc1qtest')
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /max/i })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /max/i }))
      expect(screen.getByRole('button', { name: /max/i })).toHaveAttribute('aria-pressed', 'true')

      await user.click(screen.getByRole('button', { name: '1' }))
      expect(screen.getByRole('button', { name: /max/i })).toHaveAttribute('aria-pressed', 'false')
      // Digits keep editing normally after exiting send-all
      expect(screen.getByText('₿500,001')).toBeInTheDocument()
    })

    it('disables the Max control when spendable is zero (untrusted-pending only)', async () => {
      const user = userEvent.setup()
      const ctx = readyContext({
        balance: { confirmed: 0n, trustedPending: 0n, untrustedPending: 30000n },
        approxMaxSpendable: vi.fn(() => 0n),
      })
      renderSend(ctx)

      await submitRecipient(user, 'bc1qtest')
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /max/i })).toBeInTheDocument()
      })

      const maxBtn = screen.getByRole('button', { name: /max/i })
      // Untrusted pending never counts toward the displayed spendable figure
      expect(maxBtn).toHaveTextContent('₿0 available · Max')
      expect(maxBtn).toBeDisabled()

      await user.click(maxBtn)
      // Tap does nothing: amount stays zero, no send-all mode, no error surfaced
      expect(maxBtn).toHaveAttribute('aria-pressed', 'false')
      expect(screen.queryByText(/error|failed/i)).not.toBeInTheDocument()
    })

    it('does not render a Max control for lightning recipients; label behavior unchanged', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await submitRecipient(user, 'lnbc_no_amount')
      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })

      expect(screen.queryByRole('button', { name: /max/i })).not.toBeInTheDocument()

      // Existing label: tapping fills numpad with unified balance (50,000 + 1,000,000)
      await user.click(screen.getByText(/available/i))
      expect(screen.getByText('₿1,050,000')).toBeInTheDocument()
    })

    it('calls estimateMaxSendable and sendMax on confirm', async () => {
      const user = userEvent.setup()
      const ctx = readyContext()
      renderSend(ctx)

      await submitRecipient(user, 'bc1qtest')
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /max/i })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /max/i }))

      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      await user.click(nextBtns[nextBtns.length - 1]!)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /confirm send/i })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /confirm send/i }))

      await waitFor(() => {
        expect(screen.getByText(/sent successfully/i)).toBeInTheDocument()
      })
      if (ctx.status !== 'ready') throw new Error('unreachable')
      expect(ctx.estimateMaxSendable).toHaveBeenCalled()
      expect(ctx.sendMax).toHaveBeenCalled()
    })
  })

  describe('send all estimate-time guards (dust floor and fee ceiling)', () => {
    /** Enter recipient, tap Max, then tap Next to trigger estimateMaxSendable. */
    async function tapMaxAndNext(user: ReturnType<typeof userEvent.setup>) {
      await submitRecipient(user, 'bc1qtest')
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /max/i })).toBeInTheDocument()
      })
      await user.click(screen.getByRole('button', { name: /max/i }))
      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      await user.click(nextBtns[nextBtns.length - 1]!)
    }

    it('dust-floor rejection stays on the amount step with the friendly inline message', async () => {
      const user = userEvent.setup()
      const ctx = readyContext({
        estimateMaxSendable: vi.fn().mockRejectedValue(new Error('Balance too low to cover fees')),
      })
      renderSend(ctx)

      await tapMaxAndNext(user)

      await waitFor(() => {
        expect(screen.getByText('Balance too low to cover fees')).toBeInTheDocument()
      })
      // Still on the amount step — no review, no error screen
      expect(screen.getByRole('button', { name: /max/i })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /confirm send/i })).not.toBeInTheDocument()
      expect(screen.queryByText(/send failed/i)).not.toBeInTheDocument()
    })

    it('estimate resolving exactly at the dust threshold proceeds to review (boundary)', async () => {
      const user = userEvent.setup()
      const ctx = readyContext({
        estimateMaxSendable: vi
          .fn()
          .mockResolvedValue({ amount: 294n, fee: 150n, feeRate: 1n, reserveSats: 0n }),
      })
      renderSend(ctx)

      await tapMaxAndNext(user)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /confirm send/i })).toBeInTheDocument()
      })
      expect(screen.getByText('₿294')).toBeInTheDocument()
    })

    it('fee-ceiling rejection shows the fees-too-high inline message; no review, no broadcast', async () => {
      const user = userEvent.setup()
      const ctx = readyContext({
        estimateMaxSendable: vi
          .fn()
          .mockRejectedValue(new Error('Network fees are too high right now — try again later.')),
      })
      renderSend(ctx)

      await tapMaxAndNext(user)

      await waitFor(() => {
        expect(
          screen.getByText('Network fees are too high right now — try again later.')
        ).toBeInTheDocument()
      })
      expect(screen.getByRole('button', { name: /max/i })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /confirm send/i })).not.toBeInTheDocument()
      if (ctx.status !== 'ready') throw new Error('unreachable')
      expect(ctx.sendMax).not.toHaveBeenCalled()
    })

    it('maps a raw BDK builder dust error to the friendly balance message', async () => {
      const user = userEvent.setup()
      const ctx = readyContext({
        estimateMaxSendable: vi.fn().mockRejectedValue(new Error('OutputBelowDustLimit(0)')),
      })
      renderSend(ctx)

      await tapMaxAndNext(user)

      await waitFor(() => {
        expect(screen.getByText('Balance too low to cover fees')).toBeInTheDocument()
      })
      // Raw BDK text never reaches the user
      expect(screen.queryByText(/OutputBelowDustLimit/i)).not.toBeInTheDocument()
    })

    it('maps a raw BDK insufficient-funds error to the friendly balance message', async () => {
      const user = userEvent.setup()
      const ctx = readyContext({
        estimateMaxSendable: vi
          .fn()
          .mockRejectedValue(new Error('InsufficientFunds { needed: 50000, available: 400 }')),
      })
      renderSend(ctx)

      await tapMaxAndNext(user)

      await waitFor(() => {
        expect(screen.getByText('Balance too low to cover fees')).toBeInTheDocument()
      })
      expect(screen.queryByText(/InsufficientFunds/i)).not.toBeInTheDocument()
    })

    it('sub-dust Max prefill defers to the estimate guard, not the numpad dust message', async () => {
      const user = userEvent.setup()
      const ctx = readyContext({
        balance: { confirmed: 200n, trustedPending: 0n, untrustedPending: 0n },
        approxMaxSpendable: vi.fn(() => 200n),
        estimateMaxSendable: vi.fn().mockRejectedValue(new Error('Balance too low to cover fees')),
      })
      renderSend(ctx)

      await tapMaxAndNext(user)

      await waitFor(() => {
        expect(screen.getByText('Balance too low to cover fees')).toBeInTheDocument()
      })
      // The numpad dust-limit pre-check must not fire for send-all
      expect(screen.queryByText(/dust limit/i)).not.toBeInTheDocument()
      if (ctx.status !== 'ready') throw new Error('unreachable')
      expect(ctx.estimateMaxSendable).toHaveBeenCalled()
    })

    it('normal estimate resolution still reaches review (fee-fetch fallback characterization)', async () => {
      const user = userEvent.setup()
      // getFeeRate never throws in the context layer (cached-default fallback);
      // a normally-resolving estimate must route to review.
      const ctx = readyContext()
      renderSend(ctx)

      await tapMaxAndNext(user)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /confirm send/i })).toBeInTheDocument()
      })
      expect(screen.getByText('₿49,850')).toBeInTheDocument()
    })
  })

  describe('send all review transparency (R3)', () => {
    /** Enter recipient, tap Max, tap Next, and wait for the review screen. */
    async function tapMaxToReview(user: ReturnType<typeof userEvent.setup>) {
      await submitRecipient(user, 'bc1qtest')
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /max/i })).toBeInTheDocument()
      })
      await user.click(screen.getByRole('button', { name: /max/i }))
      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      await user.click(nextBtns[nextBtns.length - 1]!)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /confirm send/i })).toBeInTheDocument()
      })
    }

    it('channels open: shows send-all notice, reserve disclosure from the estimate, and fee hedge', async () => {
      const user = userEvent.setup()
      const ctx = readyContext({
        estimateMaxSendable: vi
          .fn()
          .mockResolvedValue({ amount: 39850n, fee: 150n, feeRate: 1n, reserveSats: 10000n }),
      })
      renderSend(ctx)

      await tapMaxToReview(user)

      expect(screen.getByText(/sending all available onchain funds/i)).toBeInTheDocument()
      expect(screen.getByText(/kept for lightning channel safety/i)).toBeInTheDocument()
      expect(screen.getByText('₿10,000')).toBeInTheDocument()
      expect(screen.getByText(/final fee may vary/i)).toBeInTheDocument()
    })

    it('reserve figure comes from the estimate, not a hardcoded constant', async () => {
      const user = userEvent.setup()
      const ctx = readyContext({
        estimateMaxSendable: vi
          .fn()
          .mockResolvedValue({ amount: 37505n, fee: 150n, feeRate: 1n, reserveSats: 12345n }),
      })
      renderSend(ctx)

      await tapMaxToReview(user)

      expect(screen.getByText('₿12,345')).toBeInTheDocument()
      // The default 10,000 anchor constant must not leak onto the screen
      expect(screen.queryByText('₿10,000')).not.toBeInTheDocument()
    })

    it('no channels (reserveSats 0): notice shown, no reserve line, no fee hedge', async () => {
      const user = userEvent.setup()
      // Default mock resolves with reserveSats: 0n
      const ctx = readyContext()
      renderSend(ctx)

      await tapMaxToReview(user)

      expect(screen.getByText(/sending all available onchain funds/i)).toBeInTheDocument()
      expect(screen.queryByText(/kept for lightning channel safety/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/final fee may vary/i)).not.toBeInTheDocument()
    })

    it('normal (non-max) send renders none of the send-all elements', async () => {
      const user = userEvent.setup()
      const ctx = readyContext()
      renderSend(ctx)

      await submitRecipient(user, 'bc1qtest')
      await waitFor(() => {
        expect(screen.getByRole('button', { name: '1' })).toBeInTheDocument()
      })
      await typeOnNumpad(user, '1000')
      const nextBtns = screen.getAllByRole('button', { name: /next/i })
      await user.click(nextBtns[nextBtns.length - 1]!)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /confirm send/i })).toBeInTheDocument()
      })

      expect(screen.queryByText(/sending all available onchain funds/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/kept for lightning channel safety/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/final fee may vary/i)).not.toBeInTheDocument()
    })
  })

  describe('error done and retry', () => {
    it('shows Try Again button for retryable broadcast error', async () => {
      const user = userEvent.setup()
      const ctx = readyContext({
        sendToAddress: vi.fn().mockRejectedValue(new Error('Broadcast failed')),
      })
      renderSend(ctx)

      await submitRecipient(user, 'bc1qtest')
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

      // Broadcast failure is retryable — should show "Try Again"
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
    })

    it('returns to review screen on retry', async () => {
      const user = userEvent.setup()
      const ctx = readyContext({
        sendToAddress: vi.fn().mockRejectedValue(new Error('Broadcast failed')),
      })
      renderSend(ctx)

      await submitRecipient(user, 'bc1qtest')
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

  describe('QR scanner location.state', () => {
    it('routes scanned bolt11 with amount directly to review', async () => {
      renderSend(readyContext(), readyLdkContext(), [
        { pathname: '/send', state: { scannedInput: 'lnbc_with_amount' } },
      ])

      await waitFor(() => {
        expect(screen.getByText(/review/i)).toBeInTheDocument()
      })
      expect(screen.getByText('₿50,000')).toBeInTheDocument()
    })

    it('routes scanned bolt11 without amount to numpad', async () => {
      renderSend(readyContext(), readyLdkContext(), [
        { pathname: '/send', state: { scannedInput: 'lnbc_no_amount' } },
      ])

      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })
    })

    it('shows error for invalid scanned input', async () => {
      renderSend(readyContext(), readyLdkContext(), [
        { pathname: '/send', state: { scannedInput: 'lnbc_invalid' } },
      ])

      await waitFor(() => {
        expect(screen.getByText(/invalid lightning invoice/i)).toBeInTheDocument()
      })
    })
  })
})
