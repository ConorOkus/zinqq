import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect } from 'vitest'
import { LdkContext, defaultLdkContextValue, type LdkContextValue } from '../ldk/ldk-context'
import { OnchainContext, defaultOnchainContextValue, type OnchainContextValue } from '../onchain/onchain-context'
import type { LdkNode } from '../ldk/init'
import { Home } from './Home'

function renderWithContexts(
  ldkValue?: LdkContextValue,
  onchainValue?: OnchainContextValue,
) {
  return render(
    <MemoryRouter>
      <LdkContext value={ldkValue ?? defaultLdkContextValue}>
        <OnchainContext value={onchainValue ?? defaultOnchainContextValue}>
          <Home />
        </OnchainContext>
      </LdkContext>
    </MemoryRouter>
  )
}

describe('Home', () => {
  it('renders the heading', () => {
    renderWithContexts()
    expect(screen.getByRole('heading', { name: /browser wallet/i })).toBeInTheDocument()
  })

  it('shows LDK loading state', () => {
    renderWithContexts({ status: 'loading', node: null, nodeId: null, error: null })
    expect(screen.getByText(/initializing lightning node/i)).toBeInTheDocument()
  })

  it('shows node ID when LDK ready', () => {
    renderWithContexts({
      status: 'ready',
      node: {} as unknown as LdkNode,
      nodeId: 'abc123',
      error: null,
    } as LdkContextValue)
    expect(screen.getByText(/lightning node ready/i)).toBeInTheDocument()
    expect(screen.getByText(/abc123/)).toBeInTheDocument()
  })

  it('shows LDK error message on failure', () => {
    renderWithContexts({
      status: 'error',
      node: null,
      nodeId: null,
      error: new Error('WASM failed to load'),
    })
    expect(screen.getByText(/failed to initialize/i)).toBeInTheDocument()
    expect(screen.getByText(/wasm failed to load/i)).toBeInTheDocument()
  })

  it('shows on-chain balance when ready', () => {
    renderWithContexts(undefined, {
      status: 'ready',
      balance: { confirmed: 100000n, trustedPending: 0n, untrustedPending: 0n },
      generateAddress: () => 'tb1qtest',
      error: null,
    })
    expect(screen.getByText(/100000 sats/)).toBeInTheDocument()
    expect(screen.getByText(/receive/i)).toBeInTheDocument()
  })

  it('shows pending balance when non-zero', () => {
    renderWithContexts(undefined, {
      status: 'ready',
      balance: { confirmed: 100000n, trustedPending: 2000n, untrustedPending: 500n },
      generateAddress: () => 'tb1qtest',
      error: null,
    })
    expect(screen.getByText(/\+2500 sats pending/)).toBeInTheDocument()
  })

  it('shows on-chain loading state', () => {
    renderWithContexts()
    expect(screen.getByText(/loading on-chain wallet/i)).toBeInTheDocument()
  })

  it('shows on-chain error', () => {
    renderWithContexts(undefined, {
      status: 'error',
      balance: null,
      error: new Error('BDK failed'),
    })
    expect(screen.getByText(/on-chain wallet error/i)).toBeInTheDocument()
  })
})
