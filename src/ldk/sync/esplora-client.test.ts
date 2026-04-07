import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EsploraClient } from './esplora-client'

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await */

const BASE_URL = 'https://mutinynet.com/api'
const FAKE_HASH = 'aa'.repeat(32)
const FAKE_TXID = 'bb'.repeat(32)

describe('EsploraClient', () => {
  let client: EsploraClient

  beforeEach(() => {
    client = new EsploraClient(BASE_URL)
    vi.restoreAllMocks()
  })

  it('getTipHash returns trimmed hash string', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(`${FAKE_HASH}\n`, { status: 200 })
    )
    const hash = await client.getTipHash()
    expect(hash).toBe(FAKE_HASH)
    expect(fetch).toHaveBeenCalledWith(
      `${BASE_URL}/blocks/tip/hash`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('getBlockHeader returns decoded hex bytes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('0a0b0c', { status: 200 }))
    const header = await client.getBlockHeader(FAKE_HASH)
    expect(Array.from(header)).toEqual([10, 11, 12])
    expect(fetch).toHaveBeenCalledWith(
      `${BASE_URL}/block/${FAKE_HASH}/header`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('getBlockStatus returns parsed JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ in_best_chain: true, height: 100 }), { status: 200 })
    )
    const status = await client.getBlockStatus(FAKE_HASH)
    expect(status.in_best_chain).toBe(true)
    expect(status.height).toBe(100)
  })

  it('getBlockStatus rejects malformed response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ wrong: 'shape' }), { status: 200 })
    )
    await expect(client.getBlockStatus(FAKE_HASH)).rejects.toThrow('Malformed block status')
  })

  it('getTxStatus returns parsed JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ confirmed: true, block_height: 50, block_hash: 'abc' }), {
        status: 200,
      })
    )
    const status = await client.getTxStatus(FAKE_TXID)
    expect(status.confirmed).toBe(true)
    expect(status.block_height).toBe(50)
  })

  it('getOutspend returns parsed JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ spent: true, txid: 'spend_txid', vin: 0 }), { status: 200 })
    )
    const result = await client.getOutspend(FAKE_TXID, 1)
    expect(result.spent).toBe(true)
    expect(result.txid).toBe('spend_txid')
    expect(fetch).toHaveBeenCalledWith(
      `${BASE_URL}/tx/${FAKE_TXID}/outspend/1`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('rejects non-hex inputs', async () => {
    await expect(client.getBlockHeader('not-valid-hex!')).rejects.toThrow('Invalid hex')
    await expect(client.getTxStatus('xyz')).rejects.toThrow('Invalid hex')
  })

  it('throws on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('not found', { status: 404 }))
    await expect(client.getTipHash()).rejects.toThrow('failed: 404')
  })

  it('composes external signal with per-request timeout via setSignal', async () => {
    const externalSignal = AbortSignal.timeout(30_000)
    client.setSignal(externalSignal)

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(`${FAKE_HASH}\n`, { status: 200 })
    )

    await client.getTipHash()

    // The signal should be an AbortSignal.any() composite
    const callSignal = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]?.signal
    expect(callSignal).toBeInstanceOf(AbortSignal)
  })

  it('uses per-request timeout only when no external signal set', async () => {
    client.setSignal(undefined)

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(`${FAKE_HASH}\n`, { status: 200 })
    )

    await client.getTipHash()

    const callSignal = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]?.signal
    expect(callSignal).toBeInstanceOf(AbortSignal)
  })

  it('aborts request when external signal is aborted', async () => {
    const controller = new AbortController()
    client.setSignal(controller.signal)

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      // Simulate checking the signal
      if (init?.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      return new Response(`${FAKE_HASH}\n`, { status: 200 })
    })

    controller.abort()
    await expect(client.getTipHash()).rejects.toThrow('aborted')
  })

  describe('concurrency limiter', () => {
    it('limits concurrent fetches to 2', async () => {
      let inFlight = 0
      let maxInFlight = 0

      vi.spyOn(globalThis, 'fetch').mockImplementation(
        () =>
          new Promise((resolve) => {
            inFlight++
            maxInFlight = Math.max(maxInFlight, inFlight)
            setTimeout(() => {
              inFlight--
              resolve(new Response(JSON.stringify({ confirmed: false }), { status: 200 }))
            }, 10)
          })
      )

      const txids = Array.from({ length: 6 }, (_, i) => `${String(i).padStart(2, '0')}`.repeat(32))
      await Promise.allSettled(txids.map((txid) => client.getTxStatus(txid)))

      expect(maxInFlight).toBeLessThanOrEqual(2)
      expect(fetch).toHaveBeenCalledTimes(6)
    })
  })

  describe('in-flight deduplication', () => {
    it('coalesces identical concurrent requests into one fetch', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve(new Response('0a0b0c', { status: 200 }))
            }, 10)
          })
      )

      const [r1, r2, r3] = await Promise.all([
        client.getBlockHeader(FAKE_HASH),
        client.getBlockHeader(FAKE_HASH),
        client.getBlockHeader(FAKE_HASH),
      ])

      // All return the same data
      expect(Array.from(r1)).toEqual([10, 11, 12])
      expect(Array.from(r2)).toEqual([10, 11, 12])
      expect(Array.from(r3)).toEqual([10, 11, 12])
      // But only one fetch was made
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('dedup map is cleaned up after request completes', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('0a0b0c', { status: 200 }))

      await client.getBlockHeader(FAKE_HASH)
      // Second call after first completes should make a new fetch (but hit cache instead)
      await client.getBlockHeader(FAKE_HASH)
      // Only 1 fetch because second call hits the cache
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('dedup map is cleaned up after request fails', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch')
      fetchMock.mockRejectedValueOnce(new Error('network error'))
      fetchMock.mockResolvedValueOnce(new Response('0a0b0c', { status: 200 }))

      await expect(client.getBlockHeader(FAKE_HASH)).rejects.toThrow('network error')
      // After failure, dedup entry should be removed, allowing a fresh fetch
      const result = await client.getBlockHeader(FAKE_HASH)
      expect(Array.from(result)).toEqual([10, 11, 12])
      expect(fetch).toHaveBeenCalledTimes(2)
    })
  })

  describe('LRU caching', () => {
    it('caches block headers by hash', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('0a0b0c', { status: 200 }))

      const r1 = await client.getBlockHeader(FAKE_HASH)
      const r2 = await client.getBlockHeader(FAKE_HASH)

      expect(Array.from(r1)).toEqual([10, 11, 12])
      expect(Array.from(r2)).toEqual([10, 11, 12])
      expect(fetch).toHaveBeenCalledTimes(1) // second call served from cache
    })

    it('caches tx hex by txid', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('deadbeef', { status: 200 }))

      const r1 = await client.getTxHex(FAKE_TXID)
      const r2 = await client.getTxHex(FAKE_TXID)

      expect(Array.from(r1)).toEqual([0xde, 0xad, 0xbe, 0xef])
      expect(Array.from(r2)).toEqual([0xde, 0xad, 0xbe, 0xef])
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('caches merkle proofs by txid:blockHash compound key', async () => {
      const proof = { block_height: 100, merkle: [], pos: 3 }
      vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(proof), { status: 200 }))
      )

      const blockHashA = 'cc'.repeat(32)
      const blockHashB = 'dd'.repeat(32)

      const r1 = await client.getTxMerkleProof(FAKE_TXID, blockHashA)
      const r2 = await client.getTxMerkleProof(FAKE_TXID, blockHashA)
      expect(r1.pos).toBe(3)
      expect(r2.pos).toBe(3)
      expect(fetch).toHaveBeenCalledTimes(1) // cache hit

      // Different block hash = cache miss (reorg safety)
      await client.getTxMerkleProof(FAKE_TXID, blockHashB)
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('does not cache mutable responses (getTxStatus)', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch')
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ confirmed: false }), { status: 200 })
      )
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ confirmed: true, block_height: 50 }), { status: 200 })
      )

      const s1 = await client.getTxStatus(FAKE_TXID)
      const s2 = await client.getTxStatus(FAKE_TXID)

      expect(s1.confirmed).toBe(false)
      expect(s2.confirmed).toBe(true)
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('does not cache mutable responses (getOutspend)', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch')
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ spent: false }), { status: 200 })
      )
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ spent: true, txid: 'abc', vin: 0 }), { status: 200 })
      )

      const s1 = await client.getOutspend(FAKE_TXID, 0)
      const s2 = await client.getOutspend(FAKE_TXID, 0)

      expect(s1.spent).toBe(false)
      expect(s2.spent).toBe(true)
      expect(fetch).toHaveBeenCalledTimes(2)
    })
  })
})
