// Mocks intentionally use `async () => ...` for clarity even when they have
// no `await`; the require-await rule would force `() => Promise.resolve(...)`
// or a sentinel `await Promise.resolve()`, both of which obscure intent.
/* eslint-disable @typescript-eslint/require-await */
import { describe, it, expect, vi } from 'vitest'
import {
  runJitQuoteFlow,
  computeJitInvoiceExpirySecs,
  JitPeerConnectError,
  JitPaymentSizeOutOfRangeError,
  JitQuoteFreshnessError,
  type JitQuote,
} from '../context'
import type { PeerManager } from 'lightningdevkit'
import type { LdkNode } from '../init'
import type { LspContact } from './contacts'
import type { LSPS2OpeningFeeParams } from '../lsps2/types'
import { Lsps2TimeoutError } from '../lsps2/errors'

// Spy on the incident log so we can assert failover telemetry classification.
const captureError = vi.fn()
vi.mock('../../storage/error-log', () => ({
  captureError: (...args: unknown[]): void => {
    captureError(...args)
  },
}))

// runJitQuoteFlow's orchestrator only forwards `node` to the injected
// `attempt`. A bare object suffices.
const FAKE_NODE = {} as unknown as LdkNode

// Match the real connect signature so vi.fn<AttemptFn> can substitute
// for GetJitQuoteFn without contravariance complaints.
type ConnectStub = (
  peerManager: PeerManager,
  pubkey: string,
  host: string,
  port: number
) => Promise<void>

const FAKE_CONNECT: ConnectStub = vi.fn(async () => undefined)

/**
 * Type the `attempt` mock with the full 6-arg signature so
 * `attempt.mock.calls[i]` carries every positional argument.
 */
type AttemptFn = (
  node: LdkNode,
  contact: LspContact,
  amountMsat: bigint,
  connect: ConnectStub,
  opts: { retryConnectOnce: boolean },
  signal: AbortSignal
) => Promise<JitQuote>

const PRIMARY_LSP: LspContact = {
  nodeId: '02'.padEnd(66, '0'),
  host: '3.68.244.94',
  port: 26000,
  token: null,
  label: 'primary-lsp',
}

const FALLBACK_LSP: LspContact = {
  nodeId: '03'.padEnd(66, '1'),
  host: 'fallback.example',
  port: 9735,
  token: 'fallback-token',
  label: 'fallback-lsp',
}

function makeParams(overrides: Partial<LSPS2OpeningFeeParams> = {}): LSPS2OpeningFeeParams {
  return {
    minFeeMsat: 1_000_000n,
    proportional: 5000,
    validUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
    minLifetime: 144,
    maxClientToSelfDelay: 2016,
    minPaymentSizeMsat: 1_000n,
    maxPaymentSizeMsat: 1_000_000_000n,
    promise: 'sig-' + Math.random().toString(36).slice(2),
    ...overrides,
  }
}

const QUOTE_PRIMARY: JitQuote = {
  contact: PRIMARY_LSP,
  params: makeParams({ promise: 'primary-promise' }),
  menu: [makeParams({ promise: 'primary-promise' })],
  openingFeeMsat: 1_000_000n,
  amountMsat: 50_000_000n,
}

const QUOTE_FALLBACK: JitQuote = {
  contact: FALLBACK_LSP,
  params: makeParams({ promise: 'fallback-promise' }),
  menu: [makeParams({ promise: 'fallback-promise' })],
  openingFeeMsat: 2_000_000n,
  amountMsat: 50_000_000n,
}

describe('runJitQuoteFlow — primary/fallback orchestration', () => {
  it('uses primary on the happy path and never touches fallback', async () => {
    const attempt: ReturnType<typeof vi.fn<AttemptFn>> = vi.fn<AttemptFn>(
      async (_node, contact) => {
        if (contact.label === 'primary-lsp') return QUOTE_PRIMARY
        throw new Error('should not call fallback')
      }
    )

    const result = await runJitQuoteFlow({
      node: FAKE_NODE,
      amountMsat: 50_000_000n,
      connect: FAKE_CONNECT,
      contacts: { primary: PRIMARY_LSP, fallback: FALLBACK_LSP },
      attempt,
    })

    expect(result).toEqual({ ...QUOTE_PRIMARY, role: 'primary' })
    expect(attempt).toHaveBeenCalledTimes(1)
    const firstCall = attempt.mock.calls[0]
    expect(firstCall).toBeDefined()
    expect(firstCall![1].label).toBe('primary-lsp')
    expect(firstCall![4]).toEqual({ retryConnectOnce: false })
    // The signal arg must be a real AbortSignal so per-LSP timeouts can compose.
    expect(firstCall![5]).toBeInstanceOf(AbortSignal)
  })

  // Scenario 1: the primary LSP /get_info 5xx → resolveLspContacts returned primary=null
  // → fallback runs the full LSPS2 dance against the fallback LSP.
  it('falls back to the fallback LSP when primary discovery (HTTP preflight) failed', async () => {
    const attempt: ReturnType<typeof vi.fn<AttemptFn>> = vi.fn<AttemptFn>(
      async (_node, contact) => {
        if (contact.label === 'fallback-lsp') return QUOTE_FALLBACK
        throw new Error('primary should never be attempted')
      }
    )

    const result = await runJitQuoteFlow({
      node: FAKE_NODE,
      amountMsat: 50_000_000n,
      connect: FAKE_CONNECT,
      contacts: { primary: null, fallback: FALLBACK_LSP },
      attempt,
    })

    expect(result).toEqual({ ...QUOTE_FALLBACK, role: 'fallback' })
    expect(attempt).toHaveBeenCalledTimes(1)
    const firstCall = attempt.mock.calls[0]
    expect(firstCall).toBeDefined()
    expect(firstCall![1].label).toBe('fallback-lsp')
    expect(firstCall![4]).toEqual({ retryConnectOnce: true })
  })

  // Scenario 3: peer-connect to the primary LSP fails → fallback to the fallback LSP.
  it('falls back when the primary LSP peer connect throws', async () => {
    const attempt: ReturnType<typeof vi.fn<AttemptFn>> = vi.fn<AttemptFn>(
      async (_node, contact) => {
        if (contact.label === 'primary-lsp') {
          throw new JitPeerConnectError('peer_connect (primary): timeout')
        }
        return QUOTE_FALLBACK
      }
    )

    const result = await runJitQuoteFlow({
      node: FAKE_NODE,
      amountMsat: 50_000_000n,
      connect: FAKE_CONNECT,
      contacts: { primary: PRIMARY_LSP, fallback: FALLBACK_LSP },
      attempt,
    })

    expect(result).toEqual({ ...QUOTE_FALLBACK, role: 'fallback' })
    expect(attempt).toHaveBeenCalledTimes(2)
    const [first, second] = attempt.mock.calls
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first![1].label).toBe('primary-lsp')
    expect(second![1].label).toBe('fallback-lsp')
    expect(second![4]).toEqual({ retryConnectOnce: true })
  })

  // Scenario 4: payment size outside the primary LSP's range → fallback to the fallback LSP.
  it('falls back when amount is outside the primary LSP range (payment_size_filter)', async () => {
    const attempt: ReturnType<typeof vi.fn<AttemptFn>> = vi.fn<AttemptFn>(
      async (_node, contact) => {
        if (contact.label === 'primary-lsp') {
          throw new JitPaymentSizeOutOfRangeError(
            'no fee params accept 200000000 msat from primary',
            [makeParams()],
            PRIMARY_LSP
          )
        }
        return QUOTE_FALLBACK
      }
    )

    const result = await runJitQuoteFlow({
      node: FAKE_NODE,
      amountMsat: 200_000_000n,
      connect: FAKE_CONNECT,
      contacts: { primary: PRIMARY_LSP, fallback: FALLBACK_LSP },
      attempt,
    })

    expect(result).toEqual({ ...QUOTE_FALLBACK, role: 'fallback' })
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  // Scenario: the primary LSP returned a quote whose validUntil leaves <30s headroom →
  // fallback to the fallback LSP (the LSP rotated keys but not the menu).
  it('falls back when primary returns a quote with insufficient freshness', async () => {
    const attempt: ReturnType<typeof vi.fn<AttemptFn>> = vi.fn<AttemptFn>(
      async (_node, contact) => {
        if (contact.label === 'primary-lsp') {
          throw new JitQuoteFreshnessError('Fee parameters expiring too soon, please try again')
        }
        return QUOTE_FALLBACK
      }
    )

    const result = await runJitQuoteFlow({
      node: FAKE_NODE,
      amountMsat: 50_000_000n,
      connect: FAKE_CONNECT,
      contacts: { primary: PRIMARY_LSP, fallback: FALLBACK_LSP },
      attempt,
    })

    expect(result).toEqual({ ...QUOTE_FALLBACK, role: 'fallback' })
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  // Scenario: an LSPS2 transport error (timeout/disconnect) on the primary's
  // quote is failover-eligible — it is not an AbortError, so fallback runs —
  // and it is classified distinctly in telemetry (not the generic lsps2_rpc).
  it('falls back and classifies an LSPS2 transport error distinctly', async () => {
    captureError.mockClear()
    const attempt: ReturnType<typeof vi.fn<AttemptFn>> = vi.fn<AttemptFn>(
      async (_node, contact) => {
        if (contact.label === 'primary-lsp') {
          throw new Lsps2TimeoutError()
        }
        return QUOTE_FALLBACK
      }
    )

    const result = await runJitQuoteFlow({
      node: FAKE_NODE,
      amountMsat: 50_000_000n,
      connect: FAKE_CONNECT,
      contacts: { primary: PRIMARY_LSP, fallback: FALLBACK_LSP },
      attempt,
    })

    expect(result).toEqual({ ...QUOTE_FALLBACK, role: 'fallback' })
    expect(attempt).toHaveBeenCalledTimes(2)
    // The primary→fallback warning tags the timeout as its own trigger so
    // incident logs can separate a silent LSP from a generic RPC failure.
    const fallbackLog = captureError.mock.calls.find(
      (c) => typeof c[3] === 'string' && c[3].includes('"trigger":"lsps2_timeout"')
    )
    expect(fallbackLog).toBeDefined()
  })

  // Scenario 5: both LSPs fail → throws → Receive.tsx degrades to on-chain.
  it('throws when both primary and fallback fail (degrading to on-chain)', async () => {
    const attempt: ReturnType<typeof vi.fn<AttemptFn>> = vi.fn<AttemptFn>(
      async (_node, contact) => {
        throw new Error(`${contact.label} unreachable`)
      }
    )

    await expect(
      runJitQuoteFlow({
        node: FAKE_NODE,
        amountMsat: 50_000_000n,
        connect: FAKE_CONNECT,
        contacts: { primary: PRIMARY_LSP, fallback: FALLBACK_LSP },
        attempt,
      })
    ).rejects.toThrow(/fallback-lsp unreachable/)

    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('throws when no LSP is configured at all', async () => {
    const attempt: ReturnType<typeof vi.fn<AttemptFn>> = vi.fn<AttemptFn>()
    await expect(
      runJitQuoteFlow({
        node: FAKE_NODE,
        amountMsat: 50_000_000n,
        connect: FAKE_CONNECT,
        contacts: { primary: null, fallback: null },
        attempt,
      })
    ).rejects.toThrow(/LSP not configured/)
    expect(attempt).not.toHaveBeenCalled()
  })

  it('throws when primary fails and no fallback is configured', async () => {
    const attempt: ReturnType<typeof vi.fn<AttemptFn>> = vi.fn<AttemptFn>(async () => {
      throw new JitPeerConnectError('primary unreachable')
    })

    await expect(
      runJitQuoteFlow({
        node: FAKE_NODE,
        amountMsat: 50_000_000n,
        connect: FAKE_CONNECT,
        contacts: { primary: PRIMARY_LSP, fallback: null },
        attempt,
      })
    ).rejects.toThrow(/primary unreachable/)

    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('passes the user-provided amount through to attempt', async () => {
    const attempt: ReturnType<typeof vi.fn<AttemptFn>> = vi.fn<AttemptFn>(async () => QUOTE_PRIMARY)
    await runJitQuoteFlow({
      node: FAKE_NODE,
      amountMsat: 12_345_678n,
      connect: FAKE_CONNECT,
      contacts: { primary: PRIMARY_LSP, fallback: FALLBACK_LSP },
      attempt,
    })
    const firstCall = attempt.mock.calls[0]
    expect(firstCall).toBeDefined()
    expect(firstCall![2]).toBe(12_345_678n)
  })
})

describe('runJitQuoteFlow — cancellation and timeouts', () => {
  it('aborts immediately when the external signal is already aborted', async () => {
    const attempt: ReturnType<typeof vi.fn<AttemptFn>> = vi.fn<AttemptFn>(
      async (_node, _contact, _amount, _connect, _opts, signal) => {
        // Honor the per-LSP signal so the abort surfaces synchronously.
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        return QUOTE_PRIMARY
      }
    )

    const ctrl = new AbortController()
    ctrl.abort()

    await expect(
      runJitQuoteFlow({
        node: FAKE_NODE,
        amountMsat: 50_000_000n,
        connect: FAKE_CONNECT,
        contacts: { primary: PRIMARY_LSP, fallback: FALLBACK_LSP },
        signal: ctrl.signal,
        attempt,
      })
    ).rejects.toMatchObject({ name: 'AbortError' })

    // External cancel skips fallback even though the primary "failed" (was aborted).
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('falls back when the per-LSP budget is exceeded on primary', async () => {
    vi.useFakeTimers()
    try {
      // Block until the per-LSP signal aborts, then throw AbortError.
      // `{ once: true }` ensures the listener cleans up — important when
      // the parent (overall) signal later cascades abort to derived signals.
      const waitForAbort = (signal: AbortSignal): Promise<never> =>
        new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'))
            return
          }
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          )
        })

      const attempt: ReturnType<typeof vi.fn<AttemptFn>> = vi.fn<AttemptFn>(
        async (_node, contact, _amount, _connect, _opts, signal) => {
          if (contact.label === 'primary-lsp') {
            await waitForAbort(signal)
          }
          return QUOTE_FALLBACK
        }
      )

      const promise = runJitQuoteFlow({
        node: FAKE_NODE,
        amountMsat: 50_000_000n,
        connect: FAKE_CONNECT,
        contacts: { primary: PRIMARY_LSP, fallback: FALLBACK_LSP },
        attempt,
      })

      // Advance past the 7s per-LSP budget but well under the 14s overall —
      // primary aborts, fallback runs synchronously and resolves.
      await vi.advanceTimersByTimeAsync(7_500)

      const result = await promise
      expect(result).toEqual({ ...QUOTE_FALLBACK, role: 'fallback' })
      expect(attempt).toHaveBeenCalledTimes(2)
      expect(attempt.mock.calls[1]![1].label).toBe('fallback-lsp')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('computeJitInvoiceExpirySecs — invoice expiry clamped to quote validity', () => {
  const NOW = Date.parse('2026-07-08T12:00:00.000Z')
  const validUntil = (secsFromNow: number) => new Date(NOW + secsFromNow * 1000).toISOString()

  it('caps at 3600s when the quote is valid well past an hour', () => {
    expect(computeJitInvoiceExpirySecs(validUntil(2 * 3600), NOW)).toBe(3600)
  })

  it('clamps to the quote headroom minus the 30s flight margin', () => {
    // 10-minute quote validity (observed Megalith behavior) → 570s invoice.
    expect(computeJitInvoiceExpirySecs(validUntil(600), NOW)).toBe(570)
  })

  it('returns the 60s minimum at exactly 90s of quote validity', () => {
    expect(computeJitInvoiceExpirySecs(validUntil(90), NOW)).toBe(60)
  })

  it('throws JitQuoteFreshnessError below 90s of quote validity', () => {
    expect(() => computeJitInvoiceExpirySecs(validUntil(89), NOW)).toThrow(JitQuoteFreshnessError)
  })

  it('throws JitQuoteFreshnessError for an already-expired quote', () => {
    expect(() => computeJitInvoiceExpirySecs(validUntil(-10), NOW)).toThrow(JitQuoteFreshnessError)
  })

  // Date.parse('garbage') === NaN, and NaN fails every comparison — a plain
  // `<` gate would return Math.min(3600, NaN) = NaN instead of throwing,
  // sending NaN into the buy, the u32 WASM boundary, and the BOLT11 encoder.
  it('throws JitQuoteFreshnessError for an unparseable valid_until (fails closed on NaN)', () => {
    expect(() => computeJitInvoiceExpirySecs('not-a-date', NOW)).toThrow(JitQuoteFreshnessError)
  })
})
