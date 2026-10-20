import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { BalanceDisplay } from './BalanceDisplay'

beforeEach(() => vi.stubGlobal('localStorage', { getItem: () => 'true', setItem: vi.fn() }))
afterEach(() => vi.unstubAllGlobals())
describe('stable balance privacy', () => {
  it('hides both the bitcoin equivalent and USD position', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <BalanceDisplay
          dollars="$100.00"
          bitcoinEquivalent={100000n}
          status="Awaiting provider settlement"
        />
      </MemoryRouter>
    )
    expect(screen.getByText('$100.00')).toBeVisible()
    expect(screen.getByText('₿100,000')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Hide balance' }))
    expect(screen.queryByText(/\$100/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Current backing value/)).not.toBeInTheDocument()
    expect(screen.queryByText('₿100,000')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show balance' }))
    expect(screen.getByText('$100.00')).toBeVisible()
    expect(screen.getByText('₿100,000')).toBeVisible()
  })
})
