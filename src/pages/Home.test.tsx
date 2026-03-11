import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { LdkContext, defaultLdkContextValue, type LdkContextValue } from '../ldk/ldk-context'
import type { LdkNode } from '../ldk/init'
import { Home } from './Home'

function renderWithLdk(contextValue?: LdkContextValue) {
  const value = contextValue ?? defaultLdkContextValue

  return render(
    <LdkContext value={value}>
      <Home />
    </LdkContext>
  )
}

describe('Home', () => {
  it('renders the heading', () => {
    renderWithLdk()
    expect(screen.getByRole('heading', { name: /browser wallet/i })).toBeInTheDocument()
  })

  it('shows loading state', () => {
    renderWithLdk({ status: 'loading', node: null, nodeId: null, error: null })
    expect(screen.getByText(/initializing lightning node/i)).toBeInTheDocument()
  })

  it('shows node ID when ready', () => {
    renderWithLdk({
      status: 'ready',
      node: {} as unknown as LdkNode,
      nodeId: 'abc123',
      error: null,
    })
    expect(screen.getByText(/lightning node ready/i)).toBeInTheDocument()
    expect(screen.getByText(/abc123/)).toBeInTheDocument()
  })

  it('shows error message on failure', () => {
    renderWithLdk({
      status: 'error',
      node: null,
      nodeId: null,
      error: new Error('WASM failed to load'),
    })
    expect(screen.getByText(/failed to initialize/i)).toBeInTheDocument()
    expect(screen.getByText(/wasm failed to load/i)).toBeInTheDocument()
  })
})
