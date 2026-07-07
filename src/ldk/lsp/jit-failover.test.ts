// Mocks intentionally use `async () => ...` for clarity even when they have
// no `await`; the require-await rule would force `() => Promise.resolve(...)`
// or a sentinel `await Promise.resolve()`, both of which obscure intent.
/* eslint-disable @typescript-eslint/require-await */
import { describe, it, expect, vi } from 'vitest'
import {
  runJitQuoteFlow,
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

const LQWD: LspContact = {
  nodeId: '02'.padEnd(66, '0'),
  host: '3.68.244.94',
  port: 26000,
  token: null,
  label: 'lqwd',
}

const MEGALITH: LspContact = {
  nodeId: '03'.padEnd(66, '1'),
  host: 'megalith.example',
  port: 9735,
  token: 'megalith-token',
  label: 'megalith',
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

const QUOTE_LQWD: JitQuote = {
  contact: LQWD,
  params: makeParams({ promise: 'lqwd-promise' }),
  menu: [makeParams({ promise: 'lqwd-promise' })],
  openingFeeMsat: 1_000_000n,
  amountMsat: 50_000_000n,
}

const QUOTE_MEGALITH: JitQuote = {
  contact: MEGALITH,
  params: makeParams({ promise: 'megalith-promise' }),
  menu: [makeParams({ promise: 'megalith-promise' })],
  openingFeeMsat: 2_000_000n,
  amountMsat: 50_000_000n,
}

describe('runJitQuoteFlow — primary/fallback orchestration', () => {
  it('uses primary on the happy path and never touches fallback', async () => {
    const attempt: ReturnType<typeof vi.fn<AttemptFn>> = vi.fn<AttemptFn>(
      async (_node, contact) => {
        if (contact.label === 'lqwd') return QUOTE_LQWD
        throw new Error('should not call megalith')
      }
    )

    const result = await runJitQuoteFlow({
      node: FAKE_NODE,
      amountMsat: 50_000_000n,
      connect: FAKE_CONNECT,
      contacts: { primary: LQWD, fallback: MEGALITH },
      attempt,
    })

    expect(result).toEqual({ ...QUOTE_LQWD, role: 'primary' })
    expect(attempt).toHaveBeenCalledTimes(1)
    const firstCall = attempt.mock.calls[0]
    expect(firstCall).toBeDefined()
    expect(firstCall![1].label).toBe('lqwd')
    expect(firstCall![4]).toEqual({ retryConnectOnce: false })
    // The signal arg must be a real AbortSignal so per-LSP timeouts can compose.
    expect(firstCall![5]).toBeInstanceOf(AbortSignal)
  })

  // Scenario 1: LQwD /get_info 5xx → resolveLspContacts returned primary=null
  // → fallback runs the full LSPS2 dance against Megalith.
  it('falls back to Megalith when primary discovery (HTTP preflight) failed', async () => {
    const attempt: ReturnType<typeof vi.fn<AttemptFn>> = vi.fn<AttemptFn>(
      async (_node, contact) => {
        if (contact.label === 'megalith') return QUOTE_MEGALITH
        throw new Error('lqwd should never be attempted')
      }
    )

    const result = await runJitQuoteFlow({
      node: FAKE_NODE,
      amountMsat: 50_000_000n,
      connect: FAKE_CONNECT,
      contacts: { primary: null, fallback: MEGALITH },
      attempt,
    })

    expect(result).toEqual({ ...QUOTE_MEGALITH, role: 'fallback' })
    expect(attempt).toHaveBeenCalledTimes(1)
    const firstCall = attempt.mock.calls[0]
    expect(firstCall).toBeDefined()
    expect(firstCall![1].label).toBe('megalith')
    expect(firstCall![4]).toEqual({ retryConnectOnce: true })
  })

  // Scenario 3: peer-connect to LQwD fails → fallback to Megalith.
  it('falls back when LQwD peer connect throws', async () => {
    const attempt: ReturnType<typeof vi.fn<AttemptFn>> = vi.fn<AttemptFn>(
      async (_node, contact) => {
        if (contact.label === 'lqwd') {
          throw new JitPeerConnectError('peer_connect (lqwd): timeout')
        }
        return QUOTE_MEGALITH
      }
    )

    const result = await runJitQuoteFlow({
      node: FAKE_NODE,
      amountMsat: 50_000_000n,
      connect: FAKE_CONNECT,
      contacts: { primary: LQWD, fallback: MEGALITH },
      attempt,
    })

    expect(result).toEqual({ ...QUOTE_MEGALITH, role: 'fallback' })
    expect(attempt).toHaveBeenCalledTimes(2)
    const [first, second] = attempt.mock.calls
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first![1].label).toBe('lqwd')
    expect(second![1].label).toBe('megalith')
    expect(second![4]).toEqual({ retryConnectOnce: true })
  })

  // Scenario 4: payment size outside LQwD's range → fallback to Megalith.
  it('falls back when amount is outside LQwD range (payment_size_filter)', async () => {
    const attempt: ReturnType<typeof vi.fn<AttemptFn>> = vi.fn<AttemptFn>(
      async (_node, contact) => {
        if (contact.label === 'lqwd') {
          throw new JitPaymentSizeOutOfRangeError(
            'no fee params accept 200000000 msat from lqwd',
            [makeParams()],
            LQWD
          )
        }
        return QUOTE_MEGALITH
      }
    )

    const result = await runJitQuoteFlow({
      node: FAKE_NODE,
      amountMsat: 200_000_000n,
      connect: FAKE_CONNECT,
      contacts: { primary: LQWD, fallback: MEGALITH },
      attempt,
    })

    expect(result).toEqual({ ...QUOTE_MEGALITH, role: 'fallback' })
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  // Scenario: LQwD returned a quote whose validUntil leaves <30s headroom →
  // fallback to Megalith (the LSP rotated keys but not the menu).
  it('falls back when primary returns a quote with insufficient freshness', async () => {
    const attempt: ReturnType<typeof vi.fn<AttemptFn>> = vi.fn<AttemptFn>(
      async (_node, contact) => {
        if (contact.label === 'lqwd') {
          throw new JitQuoteFreshnessError('Fee parameters expiring too soon, please try again')
        }
        return QUOTE_MEGALITH
      }
    )

    const result = await runJitQuoteFlow({
      node: FAKE_NODE,
      amountMsat: 50_000_000n,
      connect: FAKE_CONNECT,
      contacts: { primary: LQWD, fallback: MEGALITH },
      attempt,
    })

    expect(result).toEqual({ ...QUOTE_MEGALITH, role: 'fallback' })
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  // Scenario: an LSPS2 transport error (timeout/disconnect) on the primary's
  // quote is failover-eligible — it is not an AbortError, so fallback runs.
  it('falls back when the primary quote hits an LSPS2 transport error', async () => {
    const attempt: ReturnType<typeof vi.fn<AttemptFn>> = vi.fn<AttemptFn>(
      async (_node, contact) => {
        if (contact.label === 'lqwd') {
          throw new Lsps2TimeoutError()
        }
        return QUOTE_MEGALITH
      }
    )

    const result = await runJitQuoteFlow({
      node: FAKE_NODE,
      amountMsat: 50_000_000n,
      connect: FAKE_CONNECT,
      contacts: { primary: LQWD, fallback: MEGALITH },
      attempt,
    })

    expect(result).toEqual({ ...QUOTE_MEGALITH, role: 'fallback' })
    expect(attempt).toHaveBeenCalledTimes(2)
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
        contacts: { primary: LQWD, fallback: MEGALITH },
        attempt,
      })
    ).rejects.toThrow(/megalith unreachable/)

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
      throw new JitPeerConnectError('lqwd unreachable')
    })

    await expect(
      runJitQuoteFlow({
        node: FAKE_NODE,
        amountMsat: 50_000_000n,
        connect: FAKE_CONNECT,
        contacts: { primary: LQWD, fallback: null },
        attempt,
      })
    ).rejects.toThrow(/lqwd unreachable/)

    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('passes the user-provided amount through to attempt', async () => {
    const attempt: ReturnType<typeof vi.fn<AttemptFn>> = vi.fn<AttemptFn>(async () => QUOTE_LQWD)
    await runJitQuoteFlow({
      node: FAKE_NODE,
      amountMsat: 12_345_678n,
      connect: FAKE_CONNECT,
      contacts: { primary: LQWD, fallback: MEGALITH },
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
        return QUOTE_LQWD
      }
    )

    const ctrl = new AbortController()
    ctrl.abort()

    await expect(
      runJitQuoteFlow({
        node: FAKE_NODE,
        amountMsat: 50_000_000n,
        connect: FAKE_CONNECT,
        contacts: { primary: LQWD, fallback: MEGALITH },
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
          if (contact.label === 'lqwd') {
            await waitForAbort(signal)
          }
          return QUOTE_MEGALITH
        }
      )

      const promise = runJitQuoteFlow({
        node: FAKE_NODE,
        amountMsat: 50_000_000n,
        connect: FAKE_CONNECT,
        contacts: { primary: LQWD, fallback: MEGALITH },
        attempt,
      })

      // Advance past the 7s per-LSP budget but well under the 14s overall —
      // primary aborts, fallback runs synchronously and resolves.
      await vi.advanceTimersByTimeAsync(7_500)

      const result = await promise
      expect(result).toEqual({ ...QUOTE_MEGALITH, role: 'fallback' })
      expect(attempt).toHaveBeenCalledTimes(2)
      expect(attempt.mock.calls[1]![1].label).toBe('megalith')
    } finally {
      vi.useRealTimers()
    }
  })
})
