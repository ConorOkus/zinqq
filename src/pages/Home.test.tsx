import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, it, expect } from 'vitest'
import { LdkContext, defaultLdkContextValue, type LdkContextValue } from '../ldk/ldk-context'
import { OnchainContext, defaultOnchainContextValue, type OnchainContextValue } from '../onchain/onchain-context'
import { Home } from './Home'

function readyOnchain(overrides: Partial<Extract<OnchainContextValue, { status: 'ready' }>> = {}): OnchainContextValue {
  return {
    status: 'ready',
    balance: { confirmed: 100000n, trustedPending: 0n, untrustedPending: 0n },
    generateAddress: () => 'tb1qtest',
    estimateFee: async () => ({ fee: 245n, feeRate: 2n }),
    estimateMaxSendable: async () => ({ amount: 99000n, fee: 1000n, feeRate: 2n }),
    sendToAddress: async () => 'txid123',
    sendMax: async () => 'txid123',
    error: null,
    ...overrides,
  }
}

function readyLdk(): LdkContextValue {
  return {
    status: 'ready',
    node: {} as never,
    nodeId: 'abc123',
    error: null,
    syncStatus: 'synced',
    connectToPeer: async () => {},
    setBdkWallet: () => {},
  }
}

function renderHome(
  ldkValue?: LdkContextValue,
  onchainValue?: OnchainContextValue,
) {
  return render(
    <MemoryRouter>
      <LdkContext value={ldkValue ?? readyLdk()}>
        <OnchainContext value={onchainValue ?? readyOnchain()}>
          <Home />
        </OnchainContext>
      </LdkContext>
    </MemoryRouter>,
  )
}

describe('Home', () => {
  it('shows loading state when wallet is loading', () => {
    renderHome(defaultLdkContextValue, defaultOnchainContextValue)
    expect(screen.getByText(/loading wallet/i)).toBeInTheDocument()
  })

  it('shows error state when onchain fails', () => {
    renderHome(readyLdk(), { status: 'error', balance: null, error: new Error('BDK failed') })
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument()
    expect(screen.getByText(/bdk failed/i)).toBeInTheDocument()
  })

  it('shows unified balance in BIP 177 format', () => {
    renderHome(readyLdk(), readyOnchain({
      balance: { confirmed: 100000n, trustedPending: 5000n, untrustedPending: 0n },
    }))
    expect(screen.getByText('₿105,000')).toBeInTheDocument()
  })

  it('shows untrusted pending as secondary indicator', () => {
    renderHome(readyLdk(), readyOnchain({
      balance: { confirmed: 100000n, trustedPending: 0n, untrustedPending: 500n },
    }))
    expect(screen.getByText(/\+₿500 pending/)).toBeInTheDocument()
  })

  it('has Send and Request buttons', () => {
    renderHome()
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /request/i })).toBeInTheDocument()
  })

  it('can toggle balance visibility', async () => {
    const user = userEvent.setup()
    renderHome()
    expect(screen.getByText('₿100,000')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /hide balance/i }))
    expect(screen.queryByText('₿100,000')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /show balance/i }))
    expect(screen.getByText('₿100,000')).toBeInTheDocument()
  })

  it('shows zero balance for new wallet', () => {
    renderHome(readyLdk(), readyOnchain({
      balance: { confirmed: 0n, trustedPending: 0n, untrustedPending: 0n },
    }))
    expect(screen.getByText('₿0')).toBeInTheDocument()
  })
})
