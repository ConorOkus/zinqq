import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fetchLqwdContact, __resetForTests } from './lqwd-discovery'

const VALID_URI =
  '032c9c7648e471befa2dc2d093e0854dd138f2718c0ad93bd4411328b33d072918@3.68.244.94:26000'

const VALID_BODY = {
  min_required_channel_confirmations: 0,
  min_funding_confirms_within_blocks: 3,
  supports_zero_channel_reserve: true,
  uris: [VALID_URI],
}

function mockFetchOnce(init: ResponseInit & { body?: unknown; reject?: unknown }) {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  if ('reject' in init) {
    fetchSpy.mockRejectedValueOnce(init.reject)
    return fetchSpy
  }
  const body = init.body === undefined ? VALID_BODY : init.body
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  fetchSpy.mockResolvedValueOnce(
    new Response(text, {
      status: init.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  )
  return fetchSpy
}

describe('fetchLqwdContact', () => {
  beforeEach(() => {
    __resetForTests()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses a valid /get_info response into an LspContact', async () => {
    mockFetchOnce({ body: VALID_BODY })
    const contact = await fetchLqwdContact()
    expect(contact.nodeId).toBe(
      '032c9c7648e471befa2dc2d093e0854dd138f2718c0ad93bd4411328b33d072918'
    )
    expect(contact.host).toBe('3.68.244.94')
    expect(contact.port).toBe(26000)
    expect(contact.token).toBeNull()
    expect(contact.label).toBe('lqwd')
  })

  it('uses cache: "no-store" and a request timeout', async () => {
    const fetchSpy = mockFetchOnce({ body: VALID_BODY })
    await fetchLqwdContact()
    const firstCall = fetchSpy.mock.calls[0]
    expect(firstCall).toBeDefined()
    const init = firstCall![1]
    expect(init?.cache).toBe('no-store')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('rejects on non-2xx HTTP status', async () => {
    mockFetchOnce({ body: VALID_BODY, status: 503 })
    await expect(fetchLqwdContact()).rejects.toThrow(/503/)
  })

  it('rejects on malformed JSON', async () => {
    mockFetchOnce({ body: '{not json' })
    await expect(fetchLqwdContact()).rejects.toThrow()
  })

  it('rejects when uris is missing', async () => {
    mockFetchOnce({ body: { other: 'fields' } })
    await expect(fetchLqwdContact()).rejects.toThrow(/missing or empty uris/)
  })

  it('rejects when uris is empty', async () => {
    mockFetchOnce({ body: { uris: [] } })
    await expect(fetchLqwdContact()).rejects.toThrow(/missing or empty uris/)
  })

  it('rejects when uris[0] is not a string', async () => {
    mockFetchOnce({ body: { uris: [123] } })
    await expect(fetchLqwdContact()).rejects.toThrow(/not a string/)
  })

  it('rejects when uris[0] does not match pubkey@host:port', async () => {
    mockFetchOnce({ body: { uris: ['not-a-valid-uri'] } })
    await expect(fetchLqwdContact()).rejects.toThrow(/shape unexpected/)
  })

  it('rejects when pubkey has wrong length', async () => {
    mockFetchOnce({ body: { uris: ['abc123@host:9735'] } })
    await expect(fetchLqwdContact()).rejects.toThrow(/shape unexpected/)
  })

  it('rejects on network error', async () => {
    mockFetchOnce({ reject: new TypeError('network error') })
    await expect(fetchLqwdContact()).rejects.toThrow(/network error/)
  })

  it('memoises in-flight requests so concurrent callers share a fetch', async () => {
    const fetchSpy = mockFetchOnce({ body: VALID_BODY })
    const [a, b, c] = await Promise.all([
      fetchLqwdContact(),
      fetchLqwdContact(),
      fetchLqwdContact(),
    ])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('reuses the resolved value on subsequent calls', async () => {
    const fetchSpy = mockFetchOnce({ body: VALID_BODY })
    await fetchLqwdContact()
    await fetchLqwdContact()
    await fetchLqwdContact()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('clears the memo on rejection so a later call can retry', async () => {
    mockFetchOnce({ body: VALID_BODY, status: 503 })
    await expect(fetchLqwdContact()).rejects.toThrow()

    const fetchSpy = mockFetchOnce({ body: VALID_BODY })
    const contact = await fetchLqwdContact()
    expect(contact.nodeId).toMatch(/^[0-9a-f]{66}$/)
    // Two underlying fetch calls: one rejected (503) + one retry (200).
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
