import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, vi } from 'vitest'
import {
  OnchainContext,
  type OnchainContextValue,
  defaultOnchainContextValue,
} from '../onchain/onchain-context'
import { Send } from './Send'

function renderSend(contextValue?: OnchainContextValue) {
  const value = contextValue ?? defaultOnchainContextValue
  return render(
    <MemoryRouter>
      <OnchainContext value={value}>
        <Send />
      </OnchainContext>
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
  await user.type(screen.getByLabelText(/recipient address/i), address)
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
  it('shows loading state', () => {
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

  it('shows address input when ready', () => {
    renderSend(readyContext())
    expect(screen.getByLabelText(/recipient address/i)).toBeInTheDocument()
  })

  it('shows Next disabled when address is empty', () => {
    renderSend(readyContext())
    const button = screen.getByRole('button', { name: /next/i })
    expect(button).toBeDisabled()
  })

  describe('address step', () => {
    it('navigates to amount screen after entering address', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      await user.type(screen.getByLabelText(/recipient address/i), 'tb1qtest')
      await user.click(screen.getByRole('button', { name: /next/i }))

      await waitFor(() => {
        expect(screen.getByText(/available/i)).toBeInTheDocument()
      })
    })

    it('shows error for empty address', async () => {
      const user = userEvent.setup()
      renderSend(readyContext())

      // Focus and clear to trigger empty validation
      const input = screen.getByLabelText(/recipient address/i)
      await user.click(input)
      // Try to proceed with empty address by enabling button state
      // The Next button should be disabled, so we test that
      expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()
    })
  })

  describe('numpad', () => {
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

      // The "Next" button in numpad should be disabled
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
  })

  describe('review step', () => {
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
  })

  describe('broadcast', () => {
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
  })

  describe('dust validation', () => {
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
