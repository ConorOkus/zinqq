import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BalanceDisplay } from './BalanceDisplay'

beforeEach(() => vi.stubGlobal('localStorage', { getItem: () => 'true', setItem: vi.fn() }))
afterEach(() => vi.unstubAllGlobals())
describe('stable balance privacy', () => {
  it('hides both the measured bitcoin balance and USD position', async () => {
    const user = userEvent.setup()
    render(
      <BalanceDisplay
        balance={200000n}
        stable={{
          target: '$100.00',
          backingValue: '$99.00',
          native: '₿100,000',
          status: 'Awaiting provider settlement',
        }}
      />
    )
    expect(screen.getByText('$100.00 USD target')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Hide balance' }))
    expect(screen.queryByText(/\$100/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Backing value/)).not.toBeInTheDocument()
    expect(screen.queryByText('₿200,000')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show balance' }))
    expect(screen.getByText('$100.00 USD target')).toBeVisible()
  })
})
