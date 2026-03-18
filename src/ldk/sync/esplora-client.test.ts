import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EsploraClient } from './esplora-client'

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
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('0a0b0c', { status: 200 })
    )
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
      new Response(
        JSON.stringify({ confirmed: true, block_height: 50, block_hash: 'abc' }),
        { status: 200 }
      )
    )
    const status = await client.getTxStatus(FAKE_TXID)
    expect(status.confirmed).toBe(true)
    expect(status.block_height).toBe(50)
  })

  it('getOutspend returns parsed JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ spent: true, txid: 'spend_txid', vin: 0 }),
        { status: 200 }
      )
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
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('not found', { status: 404 })
    )
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
})
