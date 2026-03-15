import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, it, expect } from 'vitest'
import { OnchainContext, type OnchainContextValue, defaultOnchainContextValue } from '../onchain/onchain-context'
import { Receive } from './Receive'

const TEST_ADDRESS = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'

function renderWithOnchain(contextValue?: OnchainContextValue) {
  const value = contextValue ?? defaultOnchainContextValue

  return render(
    <MemoryRouter>
      <OnchainContext value={value}>
        <Receive />
      </OnchainContext>
    </MemoryRouter>
  )
}

function readyContext(overrides?: Partial<Extract<OnchainContextValue, { status: 'ready' }>>): OnchainContextValue {
  return {
    status: 'ready',
    balance: { confirmed: 50000n, trustedPending: 0n, untrustedPending: 0n },
    generateAddress: () => TEST_ADDRESS,
    error: null,
    ...overrides,
  }
}

describe('Receive', () => {
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

  it('displays address and QR code when ready', () => {
    renderWithOnchain(readyContext())
    expect(screen.getByText(TEST_ADDRESS)).toBeInTheDocument()
    expect(screen.getByLabelText(/qr code for bitcoin address/i)).toBeInTheDocument()
  })

  it('displays confirmed balance', () => {
    renderWithOnchain(readyContext())
    expect(screen.getByText(/50000 sats/)).toBeInTheDocument()
  })

  it('shows pending balance when non-zero', () => {
    renderWithOnchain(readyContext({
      balance: { confirmed: 50000n, trustedPending: 1000n, untrustedPending: 500n },
    }))
    expect(screen.getByText(/\+1500 sats pending/)).toBeInTheDocument()
  })

  it('hides pending line when zero', () => {
    renderWithOnchain(readyContext())
    expect(screen.queryByText(/pending/i)).not.toBeInTheDocument()
  })

  describe('copy button', () => {
    it('shows copied feedback after clicking', async () => {
      const user = userEvent.setup()
      renderWithOnchain(readyContext())

      const copyButton = screen.getByRole('button', { name: /copy address/i })
      await user.click(copyButton)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument()
      })
    })
  })
})
