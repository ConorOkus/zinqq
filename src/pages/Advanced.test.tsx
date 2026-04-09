import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect } from 'vitest'
import { Advanced } from './Advanced'
import { LdkContext, defaultLdkContextValue } from '../ldk/ldk-context'

function renderAdvanced() {
  return render(
    <MemoryRouter>
      <LdkContext value={defaultLdkContextValue}>
        <Advanced />
      </LdkContext>
    </MemoryRouter>
  )
}

describe('Advanced', () => {
  it('renders navigation items', () => {
    renderAdvanced()
    expect(screen.getByText('Balance')).toBeInTheDocument()
    expect(screen.getByText('Peers')).toBeInTheDocument()
  })
})
