import { hexToBytes } from '../utils'
import type { BlockStatus, TxStatus, MerkleProof, OutspendStatus } from './types'

const FETCH_TIMEOUT_MS = 10_000

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

export class EsploraClient {
  readonly baseUrl: string
  private externalSignal: AbortSignal | undefined

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

  async getTipHash(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/blocks/tip/hash`, { signal: this.getSignal() })
    if (!res.ok) throw new Error(`[Esplora] GET /blocks/tip/hash failed: ${res.status}`)
    const hash = (await res.text()).trim()
    assertHex(hash, 'tipHash', 64)
    return hash
  }

  async getBlockHash(height: number): Promise<string> {
    const res = await fetch(`${this.baseUrl}/block-height/${height}`, { signal: this.getSignal() })
    if (!res.ok) throw new Error(`[Esplora] GET /block-height/${height} failed: ${res.status}`)
    const hash = (await res.text()).trim()
    assertHex(hash, 'blockHash', 64)
    return hash
  }

  async getBlockHeader(hash: string): Promise<Uint8Array> {
    assertHex(hash, 'blockHash', 64)
    const res = await fetch(`${this.baseUrl}/block/${hash}/header`, { signal: this.getSignal() })
    if (!res.ok) throw new Error(`[Esplora] GET /block/${hash}/header failed: ${res.status}`)
    const hex = (await res.text()).trim()
    assertHex(hex, 'blockHeader')
    return hexToBytes(hex)
  }

  async getBlockHeight(hash: string): Promise<number> {
    const status = await this.getBlockStatus(hash)
    return status.height
  }

  async getBlockStatus(hash: string): Promise<BlockStatus> {
    assertHex(hash, 'blockHash', 64)
    const res = await fetch(`${this.baseUrl}/block/${hash}/status`, { signal: this.getSignal() })
    if (!res.ok) throw new Error(`[Esplora] GET /block/${hash}/status failed: ${res.status}`)
    const data: unknown = await res.json()
    if (typeof data !== 'object' || data === null || !('in_best_chain' in data)) {
      throw new Error('[Esplora] Malformed block status response')
    }
    return data as BlockStatus
  }

  async getTxStatus(txid: string): Promise<TxStatus> {
    assertHex(txid, 'txid', 64)
    const res = await fetch(`${this.baseUrl}/tx/${txid}/status`, { signal: this.getSignal() })
    if (!res.ok) throw new Error(`[Esplora] GET /tx/${txid}/status failed: ${res.status}`)
    const data: unknown = await res.json()
    if (typeof data !== 'object' || data === null || !('confirmed' in data)) {
      throw new Error('[Esplora] Malformed tx status response')
    }
    return data as TxStatus
  }

  async getTxHex(txid: string): Promise<Uint8Array> {
    assertHex(txid, 'txid', 64)
    const res = await fetch(`${this.baseUrl}/tx/${txid}/hex`, { signal: this.getSignal() })
    if (!res.ok) throw new Error(`[Esplora] GET /tx/${txid}/hex failed: ${res.status}`)
    const hex = (await res.text()).trim()
    assertHex(hex, 'txHex')
    return hexToBytes(hex)
  }

  async getTxMerkleProof(txid: string): Promise<MerkleProof> {
    assertHex(txid, 'txid', 64)
    const res = await fetch(`${this.baseUrl}/tx/${txid}/merkle-proof`, { signal: this.getSignal() })
    if (!res.ok) throw new Error(`[Esplora] GET /tx/${txid}/merkle-proof failed: ${res.status}`)
    const data: unknown = await res.json()
    if (
      typeof data !== 'object' ||
      data === null ||
      !('pos' in data) ||
      !('block_height' in data)
    ) {
      throw new Error('[Esplora] Malformed merkle proof response')
    }
    return data as MerkleProof
  }

  async getOutspend(txid: string, vout: number): Promise<OutspendStatus> {
    assertHex(txid, 'txid', 64)
    const res = await fetch(`${this.baseUrl}/tx/${txid}/outspend/${vout}`, {
      signal: this.getSignal(),
    })
    if (!res.ok) throw new Error(`[Esplora] GET /tx/${txid}/outspend/${vout} failed: ${res.status}`)
    const data: unknown = await res.json()
    if (typeof data !== 'object' || data === null || !('spent' in data)) {
      throw new Error('[Esplora] Malformed outspend response')
    }
    return data as OutspendStatus
  }
}
