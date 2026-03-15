import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, vi } from 'vitest'
import {
  OnchainContext,
  type OnchainContextValue,
  defaultOnchainContextValue,
} from '../onchain/onchain-context'
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
    error: null,
    ...overrides,
  }
}

function renderReceive(contextValue?: OnchainContextValue) {
  return render(
    <MemoryRouter>
      <OnchainContext value={contextValue ?? readyContext()}>
        <Receive />
      </OnchainContext>
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

  it('shows truncated address', () => {
    renderReceive()
    expect(screen.getByText(/tb1qw508d6qe\.\.\.7kxpjzsx/)).toBeInTheDocument()
  })

  it('shows Request heading', () => {
    renderReceive()
    expect(screen.getByText('Request')).toBeInTheDocument()
  })

  it('has a close button', () => {
    renderReceive()
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument()
  })

  it('has a copy button', () => {
    renderReceive()
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument()
  })

  describe('focus trap', () => {
    it('focuses the first focusable element on mount', () => {
      renderReceive(readyContext())
      // The close button in ScreenHeader is the first focusable element
      const closeButton = screen.getByRole('button', { name: /close/i })
      expect(closeButton).toHaveFocus()
    })

    it('wraps focus from last to first element on Tab', async () => {
      const user = userEvent.setup()
      renderReceive(readyContext())

      // Tab past the last focusable element should wrap to first
      const closeButton = screen.getByRole('button', { name: /close/i })
      const copyButton = screen.getByRole('button', { name: /copy/i })
      copyButton.focus()
      await user.keyboard('{Tab}')
      expect(closeButton).toHaveFocus()
    })

    it('wraps focus from first to last element on Shift+Tab', async () => {
      const user = userEvent.setup()
      renderReceive(readyContext())

      const closeButton = screen.getByRole('button', { name: /close/i })
      closeButton.focus()
      await user.keyboard('{Shift>}{Tab}{/Shift}')
      // Should wrap to last focusable element (Copy button)
      const copyButton = screen.getByRole('button', { name: /copy/i })
      expect(copyButton).toHaveFocus()
    })
  })
})
