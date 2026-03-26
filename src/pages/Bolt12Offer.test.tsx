import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, vi } from 'vitest'
import { LdkContext, defaultLdkContextValue, type LdkContextValue } from '../ldk/ldk-context'
import { Bolt12Offer } from './Bolt12Offer'

function readyLdk(
  overrides?: Partial<Extract<LdkContextValue, { status: 'ready' }>>
): LdkContextValue {
  return {
    status: 'ready',
    node: {} as never,
    nodeId: 'abc123',
    error: null,
    syncStatus: 'synced',
    connectToPeer: async () => {},
    forgetPeer: async () => {},
    createChannel: () => true,
    closeChannel: () => true,
    forceCloseChannel: () => true,
    listChannels: () => [],
    bdkWallet: {} as never,
    bdkEsploraClient: {} as never,
    setSyncNeeded: () => {},
    sendBolt11Payment: () => new Uint8Array(),
    sendBolt12Payment: () => new Uint8Array(),
    abandonPayment: () => {},
    getPaymentResult: () => null,
    listRecentPayments: () => [],
    outboundCapacityMsat: () => 0n,
    lightningBalanceSats: 0n,
    createInvoice: () => 'lnbc1test',
    channelChangeCounter: 0,
    peersReconnected: true,
    paymentHistory: [],
    bolt12Offer: null,
    vssStatus: 'ok',
    shutdown: () => {},
    ...overrides,
  }
}

function renderBolt12Offer(ldkValue?: LdkContextValue) {
  return render(
    <MemoryRouter>
      <LdkContext value={ldkValue ?? defaultLdkContextValue}>
        <Bolt12Offer />
      </LdkContext>
    </MemoryRouter>
  )
}

describe('Bolt12Offer', () => {
  it('shows loading state when LDK is not ready', () => {
    renderBolt12Offer(defaultLdkContextValue)
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('shows creating state when offer is null but LDK is ready', () => {
    renderBolt12Offer(readyLdk({ bolt12Offer: null }))
    expect(screen.getByText('Creating offer...')).toBeInTheDocument()
  })

  it('displays QR code and truncated offer when available', () => {
    const offer = 'lno1qgsyxjtl6luzd9t3pr62xr7eemp6awlejuef9fpksjergz35syk5tl'
    renderBolt12Offer(readyLdk({ bolt12Offer: offer }))

    expect(screen.getByText(/lno1qgsyxjtl/)).toBeInTheDocument()
    expect(screen.getByLabelText('QR code for BOLT 12 offer')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument()
  })

  it('copies offer to clipboard and shows feedback', async () => {
    const user = userEvent.setup()
    const offer = 'lno1qgsyxjtl6luzd9t3pr62xr7eemp6awlejuef9fpksjergz35syk5tl'
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true,
    })

    renderBolt12Offer(readyLdk({ bolt12Offer: offer }))

    const copyBtn = screen.getByRole('button', { name: /copy/i })
    await user.click(copyBtn)

    expect(writeText).toHaveBeenCalledWith(offer)
    expect(screen.getByText('Copied!')).toBeInTheDocument()
  })
})
