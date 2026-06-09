import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, vi } from 'vitest'
import {
  OnchainContext,
  type OnchainContextValue,
  defaultOnchainContextValue,
} from '../onchain/onchain-context'
import { LdkContext, defaultLdkContextValue, type LdkContextValue } from '../ldk/ldk-context'
import { JitPaymentSizeOutOfRangeError, type JitQuote } from '../ldk/context'
import type { OpeningFeeParams } from '../ldk/lsps2/types'
import type { LspContact } from '../ldk/lsp/contacts'
import { Receive } from './Receive'

const TEST_LSP: LspContact = {
  nodeId: '02'.padEnd(66, '0'),
  host: 'lsp.test',
  port: 9735,
  token: null,
  label: 'lqwd',
}

function makeParams(overrides: Partial<OpeningFeeParams> = {}): OpeningFeeParams {
  return {
    minFeeMsat: 2_500_000n,
    proportional: 5000,
    validUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
    minLifetime: 144,
    maxClientToSelfDelay: 2016,
    minPaymentSizeMsat: 1_000n,
    maxPaymentSizeMsat: 1_000_000_000n,
    promise: 'sig-test',
    ...overrides,
  }
}

function makeQuote(amountMsat: bigint, openingFeeMsat = 2_500_000n): JitQuote {
  const params = makeParams()
  return {
    contact: TEST_LSP,
    params,
    menu: [params],
    openingFeeMsat,
    amountMsat,
    role: 'primary',
  }
}

function readyContext(
  overrides?: Partial<Extract<OnchainContextValue, { status: 'ready' }>>
): OnchainContextValue {
  return {
    status: 'ready',
    balance: { confirmed: 50000n, trustedPending: 0n, untrustedPending: 0n },
    generateAddress: () => 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
    estimateFee: vi.fn().mockResolvedValue({ fee: 150n, feeRate: 1n }),
    estimateMaxSendable: vi.fn().mockResolvedValue({ amount: 49850n, fee: 150n, feeRate: 1n }),
    sendToAddress: vi.fn().mockResolvedValue('txid123'),
    sendMax: vi.fn().mockResolvedValue('txid123'),
    syncNow: vi.fn(),
    listTransactions: () => [],
    error: null,
    ...overrides,
  }
}

/** Create a mock ChannelDetails with the specified inbound capacity. */
function mockChannel(inboundCapacityMsat: bigint, isUsable = true) {
  return {
    get_is_usable: () => isUsable,
    get_inbound_capacity_msat: () => inboundCapacityMsat,
    get_outbound_capacity_msat: () => 500_000_000n,
    get_channel_id: () => ({ write: () => new Uint8Array(32) }),
    get_counterparty: () => ({ get_node_id: () => new Uint8Array(33) }),
    get_is_channel_ready: () => true,
  } as never
}

function readyLdkContext(
  overrides?: Partial<Extract<LdkContextValue, { status: 'ready' }>>
): LdkContextValue {
  return {
    ...defaultLdkContextValue,
    status: 'ready' as const,
    node: {} as never,
    nodeId: 'test',
    error: null,
    syncStatus: 'synced' as const,
    peersReconnected: true,
    connectToPeer: vi.fn(),
    forgetPeer: vi.fn(),
    disconnectPeer: vi.fn(),
    createChannel: vi.fn(),
    bdkWallet: {} as never,
    bdkEsploraClient: {} as never,
    setSyncNeeded: vi.fn(),
    createInvoice: vi.fn(() => ({ bolt11: 'lnbc1fakeinvoice', paymentHash: 'abc123' })),
    requestJitQuote: vi.fn(),
    executeJitBuy: vi.fn(),
    sendBolt11Payment: vi.fn(),
    sendBolt12Payment: vi.fn(),
    closeChannel: vi.fn(),
    forceCloseChannel: vi.fn(),
    listChannels: vi.fn(() => [mockChannel(1_000_000_000n)]),
    abandonPayment: vi.fn(),
    getPaymentResult: vi.fn(() => null),
    listRecentPayments: vi.fn(() => []),
    outboundCapacityMsat: vi.fn(() => 1_000_000_000n),
    lightningBalanceSats: 1_000_000n,
    channelChangeCounter: 0,
    paymentHistory: [],
    bolt12Offer: null,
    vssStatus: 'ok' as const,
    vssClient: null,
    shutdown: () => {},
    ...overrides,
  }
}

function renderReceive(contextValue?: OnchainContextValue, ldkValue?: LdkContextValue) {
  return render(
    <MemoryRouter>
      <LdkContext value={ldkValue ?? readyLdkContext()}>
        <OnchainContext value={contextValue ?? readyContext()}>
          <Receive />
        </OnchainContext>
      </LdkContext>
    </MemoryRouter>
  )
}

describe('Receive', () => {
  it('shows loading state', () => {
    renderReceive(defaultOnchainContextValue)
    expect(screen.queryByLabelText(/qr code/i)).not.toBeInTheDocument()
  })

  it('shows error state', () => {
    renderReceive({ status: 'error', balance: null, error: new Error('BDK failed') })
    expect(screen.getByText(/failed to load wallet/i)).toBeInTheDocument()
  })

  it('shows QR code when ready with inbound capacity', () => {
    renderReceive()
    expect(screen.getByLabelText(/qr code for bitcoin address/i)).toBeInTheDocument()
  })

  it('shows error when address generation fails', () => {
    renderReceive(
      readyContext({
        generateAddress: () => {
          throw new Error('BDK not initialized')
        },
      })
    )
    expect(screen.getByText(/BDK not initialized/)).toBeInTheDocument()
  })

  it('shows copy icon in header when QR is visible', () => {
    renderReceive()
    expect(screen.getByRole('button', { name: /copy payment request/i })).toBeInTheDocument()
  })

  it('opens numpad automatically when no channels exist', () => {
    renderReceive(
      undefined,
      readyLdkContext({
        listChannels: vi.fn(() => []),
      })
    )
    // Numpad is open, requesting an amount
    expect(screen.getByRole('button', { name: /request/i })).toBeInTheDocument()
    expect(screen.queryByLabelText(/qr code/i)).not.toBeInTheDocument()
  })

  it('shows Request heading', () => {
    renderReceive()
    expect(screen.getByText('Request')).toBeInTheDocument()
  })

  it('has a back button', () => {
    renderReceive()
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument()
  })

  it('opens bottom sheet when copy icon is tapped', async () => {
    const user = userEvent.setup()
    renderReceive()

    await user.click(screen.getByRole('button', { name: /copy payment request/i }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/payment request/i)).toBeInTheDocument()
  })

  describe('standard invoice path (with inbound capacity)', () => {
    it('calls createInvoice with no amount on initial load', () => {
      const createInvoice = vi.fn(() => ({
        bolt11: 'lnbc1fakeinvoice',
        paymentHash: 'abc123',
      }))
      renderReceive(undefined, readyLdkContext({ createInvoice }))
      expect(createInvoice).toHaveBeenCalledWith(undefined)
    })

    it('entering digits and confirming regenerates the invoice with amount', async () => {
      const user = userEvent.setup()
      const createInvoice = vi.fn(() => ({
        bolt11: 'lnbc1amountinvoice',
        paymentHash: 'abc123',
      }))
      renderReceive(undefined, readyLdkContext({ createInvoice }))

      await user.click(screen.getByRole('button', { name: /add amount/i }))
      await user.click(screen.getByRole('button', { name: '5' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: /done/i }))

      expect(createInvoice).toHaveBeenCalledWith(50_000_000n)
    })

    it('BIP 321 URI includes amount= when amount is set', async () => {
      const user = userEvent.setup()
      const createInvoice = vi.fn(() => ({
        bolt11: 'lnbc1amountinvoice',
        paymentHash: 'abc123',
      }))
      renderReceive(undefined, readyLdkContext({ createInvoice }))

      await user.click(screen.getByRole('button', { name: /add amount/i }))
      await user.click(screen.getByRole('button', { name: '1' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: /done/i }))

      expect(screen.getByLabelText(/amount ₿100/i)).toBeInTheDocument()
    })

    it('shows invoice error when regeneration fails with amount', async () => {
      const user = userEvent.setup()
      let callCount = 0
      const createInvoice = vi.fn(() => {
        callCount++
        if (callCount > 1) throw new Error('Invoice creation failed')
        return { bolt11: 'lnbc1fakeinvoice', paymentHash: 'abc123' }
      })
      renderReceive(undefined, readyLdkContext({ createInvoice }))

      await user.click(screen.getByRole('button', { name: /add amount/i }))
      await user.click(screen.getByRole('button', { name: '1' }))
      await user.click(screen.getByRole('button', { name: /done/i }))

      expect(screen.getByText(/failed to create lightning invoice/i)).toBeInTheDocument()
    })
  })

  describe('auto-detect: no channels (amount required)', () => {
    it('opens numpad when no channels exist', () => {
      renderReceive(
        undefined,
        readyLdkContext({
          listChannels: vi.fn(() => []),
        })
      )
      // Numpad shown with "Request" label — amount is required for JIT
      expect(screen.getByRole('button', { name: /request/i })).toBeInTheDocument()
      expect(screen.queryByLabelText(/qr code/i)).not.toBeInTheDocument()
    })
  })

  describe('auto-detect: JIT path (insufficient inbound)', () => {
    it('fetches a quote when amount exceeds inbound capacity', async () => {
      const user = userEvent.setup()
      const requestJitQuote = vi.fn().mockResolvedValue(makeQuote(50_000_000n))

      renderReceive(
        undefined,
        readyLdkContext({
          listChannels: vi.fn(() => [mockChannel(10_000_000n)]), // 10k sats inbound
          requestJitQuote,
        })
      )

      // Enter 50,000 sats (exceeds 10k inbound)
      await user.click(screen.getByRole('button', { name: /add amount/i }))
      await user.click(screen.getByRole('button', { name: '5' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: /done/i }))

      await waitFor(() => {
        expect(requestJitQuote).toHaveBeenCalled()
      })
      // First arg is amount in msat; second is the AbortSignal.
      expect(requestJitQuote.mock.calls[0]![0]).toBe(50_000_000n)
      expect(requestJitQuote.mock.calls[0]![1]).toBeInstanceOf(AbortSignal)
    })

    it('renders Review screen with fee breakdown when quote returns', async () => {
      const user = userEvent.setup()
      const requestJitQuote = vi.fn().mockResolvedValue(makeQuote(10_000_000n, 2_500_000n))

      renderReceive(
        undefined,
        readyLdkContext({
          listChannels: vi.fn(() => []),
          requestJitQuote,
        })
      )

      // Numpad already open (no channels → amount required)
      await user.click(screen.getByRole('button', { name: '1' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: /request/i }))

      // Review screen renders with the three rows.
      const reviewRegion = await screen.findByRole('region', { name: /review receive/i })
      expect(reviewRegion).toHaveTextContent('Amount')
      expect(reviewRegion).toHaveTextContent('₿10,000')
      expect(reviewRegion).toHaveTextContent('Setup fee')
      expect(reviewRegion).toHaveTextContent('₿2,500')
      expect(reviewRegion).toHaveTextContent("You'll receive")
      expect(reviewRegion).toHaveTextContent('₿7,500')

      // Generate Payment Request CTA is enabled.
      const cta = screen.getByRole('button', { name: /generate payment request/i })
      expect(cta).toBeEnabled()
    })

    it('Generate Payment Request tap calls executeJitBuy and renders QR on success', async () => {
      const user = userEvent.setup()
      const requestJitQuote = vi.fn().mockResolvedValue(makeQuote(10_000_000n, 2_500_000n))
      const executeJitBuy = vi.fn().mockResolvedValue({
        bolt11: 'lnbc1jitinvoice',
        openingFeeMsat: 2_500_000n,
        paymentHash: 'jithash',
      })

      renderReceive(
        undefined,
        readyLdkContext({
          listChannels: vi.fn(() => []),
          requestJitQuote,
          executeJitBuy,
        })
      )

      await user.click(screen.getByRole('button', { name: '1' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: /request/i }))

      const cta = await screen.findByRole('button', { name: /generate payment request/i })
      await user.click(cta)

      await waitFor(() => {
        expect(executeJitBuy).toHaveBeenCalled()
      })
      // QR renders after the buy resolves.
      await waitFor(() => {
        expect(screen.getByLabelText(/qr code for bitcoin address/i)).toBeInTheDocument()
      })
    })

    it('shows quoting skeleton during Phase A', async () => {
      const user = userEvent.setup()
      // Never resolves — the test asserts the skeleton mid-flight.
      const requestJitQuote = vi.fn().mockReturnValue(new Promise(() => {}))

      renderReceive(
        undefined,
        readyLdkContext({
          listChannels: vi.fn(() => []),
          requestJitQuote,
        })
      )

      // 50,000 sats — clears the JIT minimum so Phase A actually runs.
      await user.click(screen.getByRole('button', { name: '5' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: /request/i }))

      await waitFor(() => {
        expect(requestJitQuote).toHaveBeenCalled()
      })
      // QR is hidden, Review chrome is visible with skeleton placeholders.
      expect(screen.queryByLabelText(/qr code for bitcoin address/i)).not.toBeInTheDocument()
      expect(screen.getByLabelText(/loading setup fee/i)).toBeInTheDocument()
    })

    it('disables Generate and surfaces minimum on below-minimum amounts', async () => {
      const user = userEvent.setup()
      const params = makeParams({ minFeeMsat: 3_000_000n, minPaymentSizeMsat: 1_000n })
      const requestJitQuote = vi
        .fn()
        .mockRejectedValue(new JitPaymentSizeOutOfRangeError('too small', [params], TEST_LSP))

      renderReceive(
        undefined,
        readyLdkContext({
          listChannels: vi.fn(() => []),
          requestJitQuote,
        })
      )

      // Type 5,000 sats — clears the UI floor so Phase A runs, but the LSP
      // still rejects it as below its menu minimum (mocked above).
      await user.click(screen.getByRole('button', { name: '5' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: /request/i }))

      const cta = await screen.findByRole('button', { name: /generate payment request/i })
      expect(cta).toBeDisabled()
      // Minimum copy is rendered, and the disabled CTA is wired to it.
      expect(screen.getByText(/minimum receive/i)).toBeInTheDocument()
      expect(cta).toHaveAttribute('aria-describedby', 'receive-min-hint')
    })

    it('blocks the numpad below the 5,000-sat JIT minimum', async () => {
      const user = userEvent.setup()
      const requestJitQuote = vi.fn().mockResolvedValue(makeQuote(49_990_000n))

      renderReceive(
        undefined,
        readyLdkContext({
          listChannels: vi.fn(() => []), // no channels → JIT required
          requestJitQuote,
        })
      )

      // 4,999 sats — one below the floor.
      await user.click(screen.getByRole('button', { name: '4' }))
      await user.click(screen.getByRole('button', { name: '9' }))
      await user.click(screen.getByRole('button', { name: '9' }))
      await user.click(screen.getByRole('button', { name: '9' }))

      const next = screen.getByRole('button', { name: /request/i })
      expect(next).toBeDisabled()
      expect(screen.getByText(/minimum ₿5,000/i)).toBeInTheDocument()

      // Adding a digit (49,990) clears the floor and enables the CTA. The label
      // stays "Request" until an amount is confirmed.
      await user.click(screen.getByRole('button', { name: '0' }))
      expect(screen.getByRole('button', { name: /request/i })).toBeEnabled()
      await user.click(screen.getByRole('button', { name: /request/i }))
      await waitFor(() => expect(requestJitQuote).toHaveBeenCalled())
    })

    it('re-quotes the fallback LSP and re-confirms when the primary buy fails', async () => {
      const user = userEvent.setup()
      // First quote = primary (lqwd). Second quote (skipPrimary) = fallback.
      const requestJitQuote = vi
        .fn()
        // First quote = primary (role 'primary'); its buy fails below.
        .mockResolvedValueOnce(makeQuote(50_000_000n, 50n))
        // Re-quote (skipPrimary) returns the fallback's quote (role 'fallback').
        .mockResolvedValueOnce({ ...makeQuote(50_000_000n, 3_000_000n), role: 'fallback' as const })
      const executeJitBuy = vi.fn().mockRejectedValue(new Error('LSPS2 request timed out'))

      renderReceive(
        undefined,
        readyLdkContext({
          listChannels: vi.fn(() => []),
          requestJitQuote,
          executeJitBuy,
        })
      )

      await user.click(screen.getByRole('button', { name: '5' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: /request/i }))

      // First Review (primary, lqwd) → commit.
      const cta = await screen.findByRole('button', { name: /generate payment request/i })
      await user.click(cta)

      // Primary buy fails → auto re-quote fallback → Review re-appears with the
      // fallback's (higher) fee and the backup-provider disclosure.
      await waitFor(() => {
        expect(screen.getByText(/backup provider at a higher fee/i)).toBeInTheDocument()
      })
      const reviewRegion = screen.getByRole('region', { name: /review receive/i })
      expect(reviewRegion).toHaveTextContent('₿3,000') // fallback setup fee
      // Second quote was requested with skipPrimary.
      expect(requestJitQuote).toHaveBeenCalledTimes(2)
      expect(requestJitQuote.mock.calls[1]![2]).toEqual({ skipPrimary: true })
    })

    it('falls back to on-chain only when Phase A fails for non-size reasons', async () => {
      const user = userEvent.setup()
      const requestJitQuote = vi.fn().mockRejectedValue(new Error('LSP unreachable'))

      renderReceive(
        undefined,
        readyLdkContext({
          listChannels: vi.fn(() => []),
          requestJitQuote,
        })
      )

      // 50,000 sats — clears the JIT minimum so Phase A actually runs.
      await user.click(screen.getByRole('button', { name: '5' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: /request/i }))

      // Should fall back to QR (on-chain only).
      await waitFor(() => {
        expect(screen.getByLabelText(/qr code for bitcoin address/i)).toBeInTheDocument()
      })
    })
  })

  describe('success detection', () => {
    it('shows success screen when payment is received', () => {
      renderReceive(
        undefined,
        readyLdkContext({
          paymentHistory: [
            {
              paymentHash: 'abc123',
              direction: 'inbound',
              amountMsat: 50_000_000n,
              status: 'succeeded',
              feePaidMsat: null,
              createdAt: Date.now(),
              failureReason: null,
            },
          ],
        })
      )

      expect(screen.getByText(/payment received/i)).toBeInTheDocument()
      expect(screen.getByText('₿50,000')).toBeInTheDocument()
    })
  })

  describe('amount entry', () => {
    it('shows "Add amount" label on initial render', () => {
      renderReceive()
      expect(screen.getByRole('button', { name: /add amount/i })).toBeInTheDocument()
    })

    it('tapping "Add amount" shows the numpad and hides the QR', async () => {
      const user = userEvent.setup()
      renderReceive()

      await user.click(screen.getByRole('button', { name: /add amount/i }))

      expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument()
      expect(screen.queryByLabelText(/qr code/i)).not.toBeInTheDocument()
    })

    it('cancel returns to QR without changing amount', async () => {
      const user = userEvent.setup()
      renderReceive()

      await user.click(screen.getByRole('button', { name: /add amount/i }))
      await user.click(screen.getByRole('button', { name: '5' }))
      await user.click(screen.getByRole('button', { name: /cancel/i }))

      expect(screen.getByRole('button', { name: /add amount/i })).toBeInTheDocument()
      expect(screen.getByLabelText(/qr code/i)).toBeInTheDocument()
    })

    it('tapping "Edit amount" re-opens numpad with pre-populated digits', async () => {
      const user = userEvent.setup()
      renderReceive()

      await user.click(screen.getByRole('button', { name: /add amount/i }))
      await user.click(screen.getByRole('button', { name: '5' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: /done/i }))

      expect(screen.getByText('₿500')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /edit amount/i })).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: /edit amount/i }))

      expect(screen.getByText('₿500')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument()
    })

    it('remove amount clears back to zero-amount invoice', async () => {
      const user = userEvent.setup()
      const createInvoice = vi.fn(() => ({
        bolt11: 'lnbc1fakeinvoice',
        paymentHash: 'abc123',
      }))
      renderReceive(undefined, readyLdkContext({ createInvoice }))

      await user.click(screen.getByRole('button', { name: /add amount/i }))
      await user.click(screen.getByRole('button', { name: '1' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: '0' }))
      await user.click(screen.getByRole('button', { name: /done/i }))

      await user.click(screen.getByRole('button', { name: /edit amount/i }))
      await user.click(screen.getByRole('button', { name: /remove amount/i }))

      expect(screen.getByRole('button', { name: /add amount/i })).toBeInTheDocument()

      const lastCall = createInvoice.mock.calls[createInvoice.mock.calls.length - 1]
      expect(lastCall).toEqual([undefined])
    })
  })

  describe('peer reconnection', () => {
    it('shows loading spinner when peers not yet reconnected but channels exist', () => {
      renderReceive(
        undefined,
        readyLdkContext({
          peersReconnected: false,
          listChannels: vi.fn(() => [mockChannel(1_000_000_000n, false)]),
        })
      )
      expect(screen.queryByLabelText(/qr code/i)).not.toBeInTheDocument()
    })
  })
})
