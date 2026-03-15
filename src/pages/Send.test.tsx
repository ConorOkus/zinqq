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

function renderWithOnchain(contextValue?: OnchainContextValue) {
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

describe('Send', () => {
  it('shows loading state', () => {
    renderWithOnchain()
    expect(screen.getByText(/loading wallet/i)).toBeInTheDocument()
  })

  it('shows error state with back link', () => {
    renderWithOnchain({
      status: 'error',
      balance: null,
      error: new Error('BDK init failed'),
    })
    expect(screen.getByText(/failed to load wallet/i)).toBeInTheDocument()
    expect(screen.getByText(/bdk init failed/i)).toBeInTheDocument()
    expect(screen.getByText(/back to home/i)).toBeInTheDocument()
  })

  it('shows input form when ready', () => {
    renderWithOnchain(readyContext())
    expect(screen.getByText(/send bitcoin/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/recipient address/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/amount/i)).toBeInTheDocument()
    expect(screen.getByText(/50000 sats/)).toBeInTheDocument()
  })

  it('shows review button disabled when address is empty', () => {
    renderWithOnchain(readyContext())
    const button = screen.getByRole('button', { name: /review transaction/i })
    expect(button).toBeDisabled()
  })

  it('shows pending balance when non-zero', () => {
    renderWithOnchain(
      readyContext({
        balance: {
          confirmed: 50000n,
          trustedPending: 1000n,
          untrustedPending: 500n,
        },
      }),
    )
    expect(screen.getByText(/\+1500 sats pending/)).toBeInTheDocument()
  })

  describe('input validation', () => {
    it('shows error for empty amount', async () => {
      const user = userEvent.setup()
      renderWithOnchain(readyContext())

      await user.type(screen.getByLabelText(/recipient address/i), 'tb1qtest')
      await user.click(
        screen.getByRole('button', { name: /review transaction/i }),
      )

      await waitFor(() => {
        expect(screen.getByText(/enter an amount/i)).toBeInTheDocument()
      })
    })

    it('shows error for dust amount', async () => {
      const user = userEvent.setup()
      renderWithOnchain(readyContext())

      await user.type(screen.getByLabelText(/recipient address/i), 'tb1qtest')
      await user.type(screen.getByLabelText(/amount/i), '100')
      await user.click(
        screen.getByRole('button', { name: /review transaction/i }),
      )

      await waitFor(() => {
        expect(
          screen.getByText(/amount must be at least 294 sats/i),
        ).toBeInTheDocument()
      })
    })

    it('shows error for amount exceeding balance', async () => {
      const user = userEvent.setup()
      renderWithOnchain(readyContext())

      await user.type(screen.getByLabelText(/recipient address/i), 'tb1qtest')
      await user.type(screen.getByLabelText(/amount/i), '999999')
      await user.click(
        screen.getByRole('button', { name: /review transaction/i }),
      )

      await waitFor(() => {
        expect(
          screen.getByText(/amount exceeds available balance/i),
        ).toBeInTheDocument()
      })
    })
  })

  describe('review step', () => {
    it('displays review with correct values', async () => {
      const user = userEvent.setup()
      const ctx = readyContext()
      renderWithOnchain(ctx)

      await user.type(
        screen.getByLabelText(/recipient address/i),
        'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      )
      await user.type(screen.getByLabelText(/amount/i), '10000')
      await user.click(
        screen.getByRole('button', { name: /review transaction/i }),
      )

      await waitFor(() => {
        expect(screen.getByText(/review transaction/i)).toBeInTheDocument()
      })
      expect(screen.getByText('10000 sats')).toBeInTheDocument()
      expect(screen.getByText('150 sats')).toBeInTheDocument()
      expect(screen.getByText('10150 sats')).toBeInTheDocument()
      expect(
        screen.getByText('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'),
      ).toBeInTheDocument()
    })

    it('goes back to input from review', async () => {
      const user = userEvent.setup()
      renderWithOnchain(readyContext())

      await user.type(
        screen.getByLabelText(/recipient address/i),
        'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      )
      await user.type(screen.getByLabelText(/amount/i), '10000')
      await user.click(
        screen.getByRole('button', { name: /review transaction/i }),
      )

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /back/i }),
        ).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /back/i }))
      expect(screen.getByText(/send bitcoin/i)).toBeInTheDocument()
    })
  })

  describe('broadcast', () => {
    it('shows success with txid after confirm', async () => {
      const user = userEvent.setup()
      renderWithOnchain(readyContext())

      await user.type(
        screen.getByLabelText(/recipient address/i),
        'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      )
      await user.type(screen.getByLabelText(/amount/i), '10000')
      await user.click(
        screen.getByRole('button', { name: /review transaction/i }),
      )

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /confirm send/i }),
        ).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /confirm send/i }))

      await waitFor(() => {
        expect(screen.getByText(/transaction sent/i)).toBeInTheDocument()
      })
      expect(screen.getByText('abc123txid')).toBeInTheDocument()
    })

    it('shows error on broadcast failure', async () => {
      const user = userEvent.setup()
      const ctx = readyContext({
        sendToAddress: vi
          .fn()
          .mockRejectedValue(new Error('Broadcast failed: network error')),
      })
      renderWithOnchain(ctx)

      await user.type(
        screen.getByLabelText(/recipient address/i),
        'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      )
      await user.type(screen.getByLabelText(/amount/i), '10000')
      await user.click(
        screen.getByRole('button', { name: /review transaction/i }),
      )

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /confirm send/i }),
        ).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /confirm send/i }))

      await waitFor(() => {
        expect(screen.getByText(/send failed/i)).toBeInTheDocument()
      })
      expect(
        screen.getByText(/broadcast failed: network error/i),
      ).toBeInTheDocument()
      expect(screen.getByText(/your funds are safe/i)).toBeInTheDocument()
    })
  })

  describe('send max', () => {
    it('disables amount input when send max is toggled', async () => {
      const user = userEvent.setup()
      renderWithOnchain(readyContext())

      await user.click(screen.getByRole('button', { name: /send max/i }))

      expect(screen.getByLabelText(/amount/i)).toBeDisabled()
    })

    it('shows review with max amount', async () => {
      const user = userEvent.setup()
      renderWithOnchain(readyContext())

      await user.click(screen.getByRole('button', { name: /send max/i }))
      await user.type(
        screen.getByLabelText(/recipient address/i),
        'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      )
      await user.click(
        screen.getByRole('button', { name: /review transaction/i }),
      )

      await waitFor(() => {
        expect(screen.getByText(/review transaction/i)).toBeInTheDocument()
      })
      expect(screen.getByText('49850 sats')).toBeInTheDocument()
      expect(screen.getByText('150 sats')).toBeInTheDocument()
    })
  })
})
