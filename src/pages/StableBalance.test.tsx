import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { StableBalance } from './StableBalance'
import type { StableRuntime } from '../stable/runtime'
import type { StableSnapshot, StableTradeQuote } from '../stable/types'
import { initialStableState } from '../stable/store'

let snapshot: StableSnapshot
let runtime: StableRuntime | null
const refresh = vi.fn(() => Promise.resolve())
const quote = vi.fn()
const quoteMaximum = vi.fn()
const commit = vi.fn(() => Promise.resolve())
const enable = vi.fn(() => Promise.resolve())
vi.mock('../stable/use-stable-balance', () => ({ useStableBalance: () => snapshot }))
vi.mock('../stable/runtime', () => ({ getStableRuntime: () => runtime }))

const provider = { nodeId: '02' + '7'.repeat(64), host: 'stablechannels.com', port: 9735 }
const trade: StableTradeQuote = {
  baseline: 1,
  channelId: '1'.repeat(64),
  targetCents: 10_000n,
  backingSats: 100_000n,
  feeSats: 1010n,
  price: { priceCents: 10_000_000n, observedAt: 1000, sources: ['Coinbase', 'Kraken', 'Bitstamp'] },
}

beforeEach(() => {
  vi.clearAllMocks()
  quote.mockReturnValue(trade)
  quoteMaximum.mockReturnValue(trade)
  runtime = {
    provider,
    client: { refresh, quote, quoteMaximum, commit, pause: vi.fn(() => Promise.resolve()) },
    enable,
    quoteFunding: vi.fn(),
    confirmFunding: vi.fn(),
    stop: vi.fn(),
  } as unknown as StableRuntime
  snapshot = {
    state: { ...initialStableState(provider), enabled: true },
    price: trade.price,
    priceFresh: true,
    channel: {
      channelId: trade.channelId,
      userChannelId: '7',
      receiverSats: 200_000n,
      spendableSats: 200_000n,
      inboundSats: 200_000n,
      usable: true,
    },
    busy: false,
    status: 'Ready to allocate USD',
    error: null,
  }
})
const show = () =>
  render(
    <MemoryRouter>
      <StableBalance />
    </MemoryRouter>
  )

describe('Stable Balance', () => {
  it('fills the current value after refreshing prices and still requires review and confirmation', async () => {
    const user = userEvent.setup()
    show()
    const currentValue = screen.getByRole('button', { name: 'Use current value ($100.00)' })
    quoteMaximum.mockClear()
    await user.click(currentValue)
    expect(refresh.mock.invocationCallOrder.at(-1)).toBeLessThan(
      quoteMaximum.mock.invocationCallOrder[0]!
    )
    expect(screen.getByLabelText('USD target')).toHaveValue('100.00')
    expect(screen.queryByRole('button', { name: 'Confirm USD target' })).not.toBeInTheDocument()
    expect(commit).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Review USD target' }))
    expect(quote).toHaveBeenCalledWith(10000n)
    expect(await screen.findByRole('button', { name: 'Confirm USD target' })).toBeVisible()
    expect(commit).not.toHaveBeenCalled()
  })
  it('keeps the entered target when fresh prices are unavailable', async () => {
    const user = userEvent.setup()
    show()
    await user.type(screen.getByLabelText('USD target'), '50.00')
    quoteMaximum.mockClear()
    refresh.mockRejectedValueOnce(new Error('USD market consensus is unavailable'))
    await user.click(screen.getByRole('button', { name: 'Use current value ($100.00)' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'USD market consensus is unavailable'
    )
    expect(screen.getByLabelText('USD target')).toHaveValue('50.00')
    expect(quoteMaximum).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })
  it('keeps the page available when the current value cannot be quoted', () => {
    quoteMaximum.mockImplementation(() => {
      throw new Error('USD market consensus is unavailable')
    })
    show()
    expect(screen.getByRole('button', { name: 'Use current value (unavailable)' })).toBeVisible()
    expect(screen.getByLabelText('USD target')).toHaveValue('')
  })
  it('requires review of the fee before committing and never optimistically shows USD', async () => {
    const user = userEvent.setup()
    show()
    await user.type(screen.getByLabelText('USD target'), '100.00')
    await user.click(screen.getByRole('button', { name: 'Review USD target' }))
    expect(await screen.findByText('Trade fee: ₿1,010')).toBeVisible()
    expect(commit).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Confirm USD target' }))
    expect(commit).toHaveBeenCalledWith(trade)
    expect(screen.getByText('Not allocated')).toBeVisible()
  })
  it('requires selecting the provider before offering funding', async () => {
    snapshot = { ...snapshot, channel: null, state: { ...initialStableState(provider) } }
    const user = userEvent.setup()
    show()
    expect(screen.queryByRole('button', { name: 'Review funding invoice' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Use this provider' }))
    expect(enable).toHaveBeenCalledTimes(1)
  })
  it('shows actual backing, native BTC and an unavailable price separately from the target', () => {
    snapshot = {
      ...snapshot,
      priceFresh: false,
      status: 'Waiting for fresh USD prices',
      state: {
        ...snapshot.state!,
        position: {
          channelId: trade.channelId,
          targetUsd: 100,
          backingSats: '100000',
          syncVersion: '1',
          receipts: {},
          lastSettlementAt: 0,
        },
      },
    }
    show()
    expect(screen.getByText('$100.00')).toBeVisible()
    expect(screen.getByText('Price unavailable')).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for fresh USD prices')
    expect(screen.getAllByText('₿100,000')).toHaveLength(2)
  })
  it('does not expose trading actions while the stable client is unavailable', () => {
    runtime = null
    snapshot = { ...snapshot, state: null, error: 'Backup unavailable' }
    show()
    expect(screen.getByRole('alert')).toHaveTextContent('Backup unavailable')
    expect(screen.queryByRole('button', { name: 'Review USD target' })).not.toBeInTheDocument()
  })
})
