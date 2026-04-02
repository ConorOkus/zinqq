import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { broadcastWithRetry } from './broadcaster'

const ESPLORA_URL = 'https://test.esplora/api'
const TX_HEX = 'deadbeef01020304'
const TOTAL_RETRY_DELAY_MS = 1_000 + 2_000 + 4_000 + 8_000 // sum of all backoff delays

function mockFetchOk(txid: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: () => Promise.resolve(txid),
  })
}

function mockFetchError(status: number, body: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(body),
  })
}

describe('broadcastWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.restoreAllMocks()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns txid on successful broadcast', async () => {
    vi.stubGlobal('fetch', mockFetchOk('abc123txid'))

    const txid = await broadcastWithRetry(ESPLORA_URL, TX_HEX)

    expect(txid).toBe('abc123txid')
    expect(fetch).toHaveBeenCalledWith(`${ESPLORA_URL}/tx`, {
      method: 'POST',
      body: TX_HEX,
    })
  })

  it('throws after exhausting all retries', async () => {
    vi.stubGlobal('fetch', mockFetchError(500, 'Internal Server Error'))

    const promise = broadcastWithRetry(ESPLORA_URL, TX_HEX)
    // Attach rejection handler before advancing timers to avoid unhandled rejection
    const assertion = expect(promise).rejects.toThrow('All broadcast attempts failed')
    await vi.advanceTimersByTimeAsync(TOTAL_RETRY_DELAY_MS)
    await assertion
  })

  it('retries on failure then succeeds', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('error') })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('txid-on-retry') })
    vi.stubGlobal('fetch', mockFetch)

    const promise = broadcastWithRetry(ESPLORA_URL, TX_HEX)
    await vi.advanceTimersByTimeAsync(1_000)

    const txid = await promise
    expect(txid).toBe('txid-on-retry')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  describe('case-insensitive idempotency', () => {
    it.each([
      ['Transaction already in block chain'],
      ['TRANSACTION ALREADY IN BLOCK CHAIN'],
      ['transaction already in block chain'],
      ['txn-already-known'],
      ['Txn-Already-Known'],
      ['txn-already-confirmed'],
      ['TXN-ALREADY-CONFIRMED'],
    ])('returns already-broadcast for "%s"', async (body) => {
      vi.stubGlobal('fetch', mockFetchError(400, body))

      const result = await broadcastWithRetry(ESPLORA_URL, TX_HEX)
      expect(result).toBe('already-broadcast')
      expect(fetch).toHaveBeenCalledTimes(1) // no retries
    })
  })

  it('cleans up inflight set after success', async () => {
    vi.stubGlobal('fetch', mockFetchOk('txid1'))

    await broadcastWithRetry(ESPLORA_URL, TX_HEX)
    // Second call should NOT return 'in-flight'
    const txid = await broadcastWithRetry(ESPLORA_URL, TX_HEX)
    expect(txid).toBe('txid1')
  })

  it('cleans up inflight set after failure', async () => {
    vi.stubGlobal('fetch', mockFetchError(500, 'error'))

    const promise = broadcastWithRetry(ESPLORA_URL, TX_HEX)
    const assertion = expect(promise).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(TOTAL_RETRY_DELAY_MS)
    await assertion

    // After failure, inflight should be cleared — next call should not return 'in-flight'
    vi.stubGlobal('fetch', mockFetchOk('txid-after-failure'))
    const txid = await broadcastWithRetry(ESPLORA_URL, TX_HEX)
    expect(txid).toBe('txid-after-failure')
  })
})
