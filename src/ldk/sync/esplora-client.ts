import { hexToBytes } from '../utils'
import type { BlockStatus, TxStatus, MerkleProof, OutspendStatus } from './types'

const FETCH_TIMEOUT_MS = 10_000
const MAX_CONCURRENT = 2
const LRU_MAX_ENTRIES = 256

function assertHex(value: string, label: string, expectedLength?: number): void {
  if (!/^[0-9a-f]+$/.test(value)) {
    throw new Error(`[Esplora] Invalid hex in ${label}: ${value.slice(0, 20)}...`)
  }
  if (expectedLength !== undefined && value.length !== expectedLength) {
    throw new Error(
      `[Esplora] Invalid hex length in ${label}: expected ${expectedLength}, got ${value.length}`
    )
  }
}

class Semaphore {
  private count: number
  private queue: (() => void)[] = []

  constructor(max: number) {
    this.count = max
  }

  acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--
      return Promise.resolve()
    }
    return new Promise((resolve) => this.queue.push(resolve))
  }

  release(): void {
    const next = this.queue.shift()
    if (next) next()
    else this.count++
  }
}

/** Simple LRU cache using Map insertion order. */
class LruCache<V> {
  private map = new Map<string, V>()
  private readonly maxEntries: number

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries
  }

  get(key: string): V | undefined {
    const value = this.map.get(key)
    if (value !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key)
      this.map.set(key, value)
    }
    return value
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.maxEntries) {
      // Evict oldest (first key)
      const firstKey = this.map.keys().next().value as string
      this.map.delete(firstKey)
    }
    this.map.set(key, value)
  }
}

export class EsploraClient {
  readonly baseUrl: string
  private externalSignal: AbortSignal | undefined
  private readonly semaphore = new Semaphore(MAX_CONCURRENT)
  private readonly inflight = new Map<string, Promise<{ status: number; body: string }>>()
  private readonly headerCache = new LruCache<Uint8Array>(LRU_MAX_ENTRIES)
  private readonly txHexCache = new LruCache<Uint8Array>(LRU_MAX_ENTRIES)
  private readonly merkleProofCache = new LruCache<MerkleProof>(LRU_MAX_ENTRIES)

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  /** Set an external abort signal (e.g. overall sync timeout) that cancels all requests. */
  setSignal(signal: AbortSignal | undefined): void {
    this.externalSignal = signal
  }

  private getSignal(): AbortSignal {
    const perRequest = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    if (!this.externalSignal) return perRequest
    return AbortSignal.any([this.externalSignal, perRequest])
  }

  /**
   * Fetch with concurrency limiting and in-flight deduplication.
   * Returns the response body as text. Identical URLs that are already
   * in-flight share a single fetch and return the same body text.
   */
  private dedupFetch(url: string): Promise<{ status: number; body: string }> {
    const existing = this.inflight.get(url)
    if (existing) return existing

    const promise = this.semaphore.acquire().then(async () => {
      const signal = this.getSignal()
      try {
        const res = await fetch(url, { signal })
        const body = await res.text()
        return { status: res.status, body }
      } finally {
        this.semaphore.release()
      }
    })
    this.inflight.set(url, promise)
    void promise.catch(() => {}).finally(() => this.inflight.delete(url))
    return promise
  }

  private async fetchText(url: string, label: string): Promise<string> {
    const { status, body } = await this.dedupFetch(url)
    if (status < 200 || status >= 300) throw new Error(`[Esplora] GET ${label} failed: ${status}`)
    return body.trim()
  }

  private async fetchJson(url: string, label: string): Promise<unknown> {
    const text = await this.fetchText(url, label)
    return JSON.parse(text) as unknown
  }

  async getTipHash(): Promise<string> {
    const hash = await this.fetchText(`${this.baseUrl}/blocks/tip/hash`, '/blocks/tip/hash')
    assertHex(hash, 'tipHash', 64)
    return hash
  }

  async getBlockHash(height: number): Promise<string> {
    const hash = await this.fetchText(
      `${this.baseUrl}/block-height/${height}`,
      `/block-height/${height}`
    )
    assertHex(hash, 'blockHash', 64)
    return hash
  }

  async getBlockHeader(hash: string): Promise<Uint8Array> {
    assertHex(hash, 'blockHash', 64)
    const cached = this.headerCache.get(hash)
    if (cached) return cached.slice()

    const hex = await this.fetchText(
      `${this.baseUrl}/block/${hash}/header`,
      `/block/${hash}/header`
    )
    assertHex(hex, 'blockHeader')
    const bytes = hexToBytes(hex)
    this.headerCache.set(hash, bytes)
    return bytes
  }

  async getBlockHeight(hash: string): Promise<number> {
    const status = await this.getBlockStatus(hash)
    return status.height
  }

  async getBlockStatus(hash: string): Promise<BlockStatus> {
    assertHex(hash, 'blockHash', 64)
    const data = await this.fetchJson(
      `${this.baseUrl}/block/${hash}/status`,
      `/block/${hash}/status`
    )
    if (typeof data !== 'object' || data === null || !('in_best_chain' in data)) {
      throw new Error('[Esplora] Malformed block status response')
    }
    return data as BlockStatus
  }

  async getTxStatus(txid: string): Promise<TxStatus> {
    assertHex(txid, 'txid', 64)
    const data = await this.fetchJson(`${this.baseUrl}/tx/${txid}/status`, `/tx/${txid}/status`)
    if (typeof data !== 'object' || data === null || !('confirmed' in data)) {
      throw new Error('[Esplora] Malformed tx status response')
    }
    return data as TxStatus
  }

  async getTxHex(txid: string): Promise<Uint8Array> {
    assertHex(txid, 'txid', 64)
    const cached = this.txHexCache.get(txid)
    if (cached) return cached.slice()

    const hex = await this.fetchText(`${this.baseUrl}/tx/${txid}/hex`, `/tx/${txid}/hex`)
    assertHex(hex, 'txHex')
    const bytes = hexToBytes(hex)
    this.txHexCache.set(txid, bytes)
    return bytes
  }

  async getTxMerkleProof(txid: string, blockHash: string): Promise<MerkleProof> {
    assertHex(txid, 'txid', 64)
    const cacheKey = `${txid}:${blockHash}`
    const cached = this.merkleProofCache.get(cacheKey)
    if (cached) return cached

    const data = await this.fetchJson(
      `${this.baseUrl}/tx/${txid}/merkle-proof`,
      `/tx/${txid}/merkle-proof`
    )
    if (
      typeof data !== 'object' ||
      data === null ||
      !('pos' in data) ||
      !('block_height' in data)
    ) {
      throw new Error('[Esplora] Malformed merkle proof response')
    }
    const proof = data as MerkleProof
    this.merkleProofCache.set(cacheKey, proof)
    return proof
  }

  async getOutspend(txid: string, vout: number): Promise<OutspendStatus> {
    assertHex(txid, 'txid', 64)
    const data = await this.fetchJson(
      `${this.baseUrl}/tx/${txid}/outspend/${vout}`,
      `/tx/${txid}/outspend/${vout}`
    )
    if (typeof data !== 'object' || data === null || !('spent' in data)) {
      throw new Error('[Esplora] Malformed outspend response')
    }
    return data as OutspendStatus
  }
}
