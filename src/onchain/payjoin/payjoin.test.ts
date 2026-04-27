import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Psbt, Wallet } from '@bitcoindevkit/bdk-wallet-web'
import type { PayjoinContext } from '../../ldk/payment-input'

// vi.mock factories are hoisted; use vi.hoisted to share spies between
// factory and tests.
const { psbtFromString, validateProposal } = vi.hoisted(() => ({
  psbtFromString: vi.fn(),
  validateProposal: vi.fn(),
}))

vi.mock('./pdk', () => ({ loadPdk: vi.fn() }))
vi.mock('@bitcoindevkit/bdk-wallet-web', () => ({
  Psbt: { from_string: psbtFromString },
}))
vi.mock('./proposal-validator', () => ({ validateProposal }))

import { tryPayjoinSend, PayjoinFallback } from './payjoin'
import { loadPdk } from './pdk'

const mockedLoadPdk = vi.mocked(loadPdk)

const FAKE_PSBT = { toString: () => 'cHNidP8BAA' } as unknown as Psbt
const FAKE_WALLET = { is_mine: () => false } as unknown as Wallet
const PAYJOIN_CTX: PayjoinContext = {
  url: 'bitcoin:bc1qxyz?pj=https://payjo.in/foo',
  strict: false,
}

const fakePjUri = { checkPjSupported: () => fakePjUriChecked }
const fakePjUriChecked = { __pjuri: true }

function makePdk(opts: {
  uriParse?: () => unknown
  outcomes?: Array<{ tag: 'Progress' | 'Stasis'; psbtBase64?: string; nextCtx?: unknown }>
}) {
  const outcomeQueue = [...(opts.outcomes ?? [])]
  const reqCtx = {
    createV2PostRequest: () => ({
      request: {
        url: 'https://relay.example/foo',
        contentType: 'message/ohttp-req',
        body: new ArrayBuffer(0),
      },
      ohttpCtx: {},
    }),
    processResponse: () => ({
      save: () => sendCtx,
    }),
  }
  const sendCtx = {
    createPollRequest: () => ({
      request: {
        url: 'https://relay.example/poll',
        contentType: 'message/ohttp-req',
        body: new ArrayBuffer(0),
      },
      ohttpCtx: {},
    }),
    processResponse: () => ({
      save: () => {
        const next = outcomeQueue.shift()
        if (!next) throw new Error('test ran out of outcomes')
        return next.tag === 'Progress'
          ? { tag: 'Progress', inner: { psbtBase64: next.psbtBase64 ?? 'cHNidP_proposal' } }
          : { tag: 'Stasis', inner: { inner: next.nextCtx ?? sendCtx } }
      },
    }),
  }
  return {
    Uri: {
      parse: opts.uriParse ?? (() => fakePjUri),
    },
    SenderBuilder: class {
      buildRecommended() {
        return {
          save: () => reqCtx,
        }
      }
    },
  }
}

describe('tryPayjoinSend', () => {
  let originalLocalStorage: typeof globalThis.localStorage | undefined
  let originalFetch: typeof globalThis.fetch | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    psbtFromString.mockReset()
    validateProposal.mockReset()

    originalLocalStorage = globalThis.localStorage
    originalFetch = globalThis.fetch
    // Default: localStorage absent so isKillSwitchEnabled returns false. Tests
    // that need it install their own.
    delete (globalThis as { localStorage?: Storage }).localStorage
  })

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch
    if (originalLocalStorage)
      (globalThis as { localStorage: typeof globalThis.localStorage }).localStorage =
        originalLocalStorage
  })

  it('returns the original PSBT unchanged when the kill-switch is set', async () => {
    const fakeStorage: Record<string, string> = { zinqq_payjoin_disabled: '1' }
    ;(globalThis as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => fakeStorage[k] ?? null,
      setItem: (k: string, v: string) => {
        fakeStorage[k] = v
      },
      removeItem: (k: string) => {
        delete fakeStorage[k]
      },
      clear: () => {
        for (const k of Object.keys(fakeStorage)) delete fakeStorage[k]
      },
      key: () => null,
      length: 0,
    }

    const result = await tryPayjoinSend(FAKE_PSBT, PAYJOIN_CTX, {
      wallet: FAKE_WALLET,
      feeRate: 10n,
      signal: new AbortController().signal,
    })
    expect(result).toBe(FAKE_PSBT)
    expect(mockedLoadPdk).not.toHaveBeenCalled()
  })

  it('throws PayjoinFallback("pdk_load") when loadPdk rejects', async () => {
    mockedLoadPdk.mockRejectedValue(new Error('wasm load failed'))
    await expect(
      tryPayjoinSend(FAKE_PSBT, PAYJOIN_CTX, {
        wallet: FAKE_WALLET,
        feeRate: 10n,
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ name: 'PayjoinFallback', reason: 'pdk_load' })
  })

  it('throws PayjoinFallback("pdk_error") when URI parsing fails', async () => {
    mockedLoadPdk.mockResolvedValue(
      makePdk({
        uriParse: () => {
          throw new Error('bad uri')
        },
      }) as unknown as Awaited<ReturnType<typeof loadPdk>>
    )
    await expect(
      tryPayjoinSend(FAKE_PSBT, PAYJOIN_CTX, {
        wallet: FAKE_WALLET,
        feeRate: 10n,
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ name: 'PayjoinFallback', reason: 'pdk_error' })
  })

  it('throws PayjoinFallback("network") when initial POST returns a non-OK status', async () => {
    mockedLoadPdk.mockResolvedValue(makePdk({}) as unknown as Awaited<ReturnType<typeof loadPdk>>)
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 502 }))
    ) as typeof globalThis.fetch
    await expect(
      tryPayjoinSend(FAKE_PSBT, PAYJOIN_CTX, {
        wallet: FAKE_WALLET,
        feeRate: 10n,
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ name: 'PayjoinFallback', reason: 'network' })
  })

  it('throws PayjoinFallback("backgrounded") when the parent signal aborts before the initial POST', async () => {
    mockedLoadPdk.mockResolvedValue(makePdk({}) as unknown as Awaited<ReturnType<typeof loadPdk>>)
    const ctrl = new AbortController()
    ctrl.abort(new Error('user navigated'))
    globalThis.fetch = vi.fn((_url, init) => {
      // Simulate fetch honouring the aborted signal.
      const sig = (init as RequestInit | undefined)?.signal
      if (sig?.aborted) return Promise.reject(sig.reason as Error)
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as typeof globalThis.fetch
    await expect(
      tryPayjoinSend(FAKE_PSBT, PAYJOIN_CTX, {
        wallet: FAKE_WALLET,
        feeRate: 10n,
        signal: ctrl.signal,
      })
    ).rejects.toMatchObject({ name: 'PayjoinFallback', reason: 'backgrounded' })
  })

  it('returns a validated proposal PSBT on Progress outcome', async () => {
    const proposalPsbt = { __proposal: true } as unknown as Psbt
    psbtFromString.mockReturnValue(proposalPsbt)
    validateProposal.mockReturnValue({ ok: true })
    mockedLoadPdk.mockResolvedValue(
      makePdk({
        outcomes: [{ tag: 'Progress', psbtBase64: 'cHNidP_proposal' }],
      }) as unknown as Awaited<ReturnType<typeof loadPdk>>
    )
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(new ArrayBuffer(8), { status: 200 }))
    ) as typeof globalThis.fetch

    const result = await tryPayjoinSend(FAKE_PSBT, PAYJOIN_CTX, {
      wallet: FAKE_WALLET,
      feeRate: 10n,
      signal: new AbortController().signal,
    })
    expect(result).toBe(proposalPsbt)
    expect(psbtFromString).toHaveBeenCalledWith('cHNidP_proposal')
    expect(validateProposal).toHaveBeenCalledOnce()
  })

  it('throws PayjoinFallback("validation") when the proposal fails our checks', async () => {
    psbtFromString.mockReturnValue({ __proposal: true })
    validateProposal.mockReturnValue({ ok: false, reason: 'recipient amount decreased' })
    mockedLoadPdk.mockResolvedValue(
      makePdk({
        outcomes: [{ tag: 'Progress', psbtBase64: 'cHNidP_bad' }],
      }) as unknown as Awaited<ReturnType<typeof loadPdk>>
    )
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(new ArrayBuffer(8), { status: 200 }))
    ) as typeof globalThis.fetch

    const error = await tryPayjoinSend(FAKE_PSBT, PAYJOIN_CTX, {
      wallet: FAKE_WALLET,
      feeRate: 10n,
      signal: new AbortController().signal,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PayjoinFallback)
    expect((error as PayjoinFallback).reason).toBe('validation')
    expect((error as Error).message).toBe('recipient amount decreased')
  })
})
