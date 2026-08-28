import { describe, it, expect, vi } from 'vitest'

vi.mock('lightningdevkit', () => {
  class Result_OfferNoneZ_OK {
    res: unknown
    constructor(res: unknown) {
      this.res = res
    }
  }
  class Result_OfferNoneZ_Err {}
  return { Result_OfferNoneZ_OK, Result_OfferNoneZ_Err }
})

const { readAsyncReceiveOffer, resolvePublishedOffer } = await import('./offer')
// The mocked module's classes are typed against LDK's real declarations, whose
// constructors are protected; go through a loose alias to instantiate them.
const ldk = (await import('lightningdevkit')) as unknown as Record<
  string,
  new (...args: unknown[]) => unknown
>
const Result_OfferNoneZ_OK = ldk.Result_OfferNoneZ_OK!
const Result_OfferNoneZ_Err = ldk.Result_OfferNoneZ_Err!

function manager(result: unknown) {
  return { get_async_receive_offer: vi.fn(() => result) } as never
}

describe('readAsyncReceiveOffer', () => {
  it('returns the offer string when the handshake has completed', () => {
    const cm = manager(new Result_OfferNoneZ_OK({ ptr: 1n, to_str: () => 'lno1async' }))
    expect(readAsyncReceiveOffer(cm)).toBe('lno1async')
  })

  it('returns null when the manager has no offer yet', () => {
    expect(readAsyncReceiveOffer(manager(new Result_OfferNoneZ_Err()))).toBeNull()
  })

  // The bindings hand back a struct around a null WASM pointer instead of JS
  // null in several places; calling through to it traps the runtime.
  it('returns null for an OK result wrapping a null pointer', () => {
    const cm = manager(
      new Result_OfferNoneZ_OK({
        ptr: 0n,
        to_str: () => {
          throw new Error('should not be called')
        },
      })
    )
    expect(readAsyncReceiveOffer(cm)).toBeNull()
  })

  it('returns null when the offer encodes to an empty string', () => {
    const cm = manager(new Result_OfferNoneZ_OK({ ptr: 1n, to_str: () => '' }))
    expect(readAsyncReceiveOffer(cm)).toBeNull()
  })
})

describe('resolvePublishedOffer', () => {
  const base = {
    asyncOffer: null,
    persistedAsyncOffer: null,
    selfBuiltOffer: 'lno1self',
    revalidationExhausted: false,
  }

  it('publishes the async-receive offer when the manager returns one', () => {
    expect(resolvePublishedOffer({ ...base, asyncOffer: 'lno1async' })).toEqual({
      offer: 'lno1async',
      source: 'async',
      demoted: false,
    })
  })

  it('publishes the self-built offer while the handshake has not completed', () => {
    expect(resolvePublishedOffer(base)).toEqual({
      offer: 'lno1self',
      source: 'self-built',
      demoted: false,
    })
  })

  it('publishes a restored async offer on first paint before revalidation finishes', () => {
    expect(resolvePublishedOffer({ ...base, persistedAsyncOffer: 'lno1restored' })).toEqual({
      offer: 'lno1restored',
      source: 'async',
      demoted: false,
    })
  })

  it('prefers the manager over a disagreeing restored copy', () => {
    const resolved = resolvePublishedOffer({
      ...base,
      asyncOffer: 'lno1live',
      persistedAsyncOffer: 'lno1stale',
    })
    expect(resolved.offer).toBe('lno1live')
  })

  it('demotes to the self-built offer when revalidation is exhausted', () => {
    expect(
      resolvePublishedOffer({
        ...base,
        persistedAsyncOffer: 'lno1restored',
        revalidationExhausted: true,
      })
    ).toEqual({ offer: 'lno1self', source: 'self-built', demoted: true })
  })

  it('does not demote while the manager still returns an offer', () => {
    const resolved = resolvePublishedOffer({
      ...base,
      asyncOffer: 'lno1live',
      persistedAsyncOffer: 'lno1restored',
      revalidationExhausted: true,
    })
    expect(resolved).toEqual({ offer: 'lno1live', source: 'async', demoted: false })
  })

  it('reports no offer when neither kind is available', () => {
    expect(resolvePublishedOffer({ ...base, selfBuiltOffer: null })).toEqual({
      offer: null,
      source: 'none',
      demoted: false,
    })
  })

  it('still demotes when there is no self-built offer to fall back to', () => {
    const resolved = resolvePublishedOffer({
      ...base,
      selfBuiltOffer: null,
      persistedAsyncOffer: 'lno1restored',
      revalidationExhausted: true,
    })
    expect(resolved).toEqual({ offer: null, source: 'self-built', demoted: true })
  })
})
