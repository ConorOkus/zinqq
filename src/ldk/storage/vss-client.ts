import { create, toBinary, fromBinary } from '@bufbuild/protobuf'
import {
  GetObjectRequestSchema,
  GetObjectResponseSchema,
  PutObjectRequestSchema,
  DeleteObjectRequestSchema,
  ListKeyVersionsRequestSchema,
  ListKeyVersionsResponseSchema,
  ErrorResponseSchema,
  KeyValueSchema,
  ErrorCode,
  type KeyValue,
} from './proto/vss_pb'
import { vssEncrypt, vssDecrypt, obfuscateKey } from './vss-crypto'
import { sha256 } from '@noble/hashes/sha2.js'
import * as secp256k1 from '@noble/secp256k1'
import { bytesToHex } from '../utils'

/** Type guard: checks whether an error is a VSS version-conflict response. */
export function isVssConflict(err: unknown): err is VssError {
  return err instanceof VssError && err.errorCode === ErrorCode.CONFLICT_EXCEPTION
}

const FETCH_TIMEOUT_MS = 15_000
const MAX_LIST_PAGES = 100

export interface VssHeaderProvider {
  getHeaders(): Promise<Record<string, string>>
}

export class FixedHeaderProvider implements VssHeaderProvider {
  #headers: Record<string, string>
  constructor(headers: Record<string, string>) {
    this.#headers = { ...headers }
  }
  getHeaders(): Promise<Record<string, string>> {
    return Promise.resolve({ ...this.#headers })
  }
}

const VSS_SIGNING_CONSTANT = new TextEncoder().encode(
  'VSS Signature Authorizer Signing Salt Constant..................'
)

export class SignatureHeaderProvider implements VssHeaderProvider {
  #secretKey: Uint8Array

  constructor(secretKey: Uint8Array) {
    this.#secretKey = new Uint8Array(secretKey)
  }

  async getHeaders(): Promise<Record<string, string>> {
    const pubkeyBytes = secp256k1.getPublicKey(this.#secretKey, true)
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const timestampBytes = new TextEncoder().encode(timestamp)

    const preimage = new Uint8Array(
      VSS_SIGNING_CONSTANT.length + pubkeyBytes.length + timestampBytes.length
    )
    preimage.set(VSS_SIGNING_CONSTANT, 0)
    preimage.set(pubkeyBytes, VSS_SIGNING_CONSTANT.length)
    preimage.set(timestampBytes, VSS_SIGNING_CONSTANT.length + pubkeyBytes.length)

    const hash = sha256(preimage)
    const sigBytes = await secp256k1.signAsync(hash, this.#secretKey, {
      prehash: false,
      format: 'compact',
    })

    return {
      authorization: bytesToHex(pubkeyBytes) + bytesToHex(sigBytes) + timestamp,
    }
  }
}

export class VssError extends Error {
  readonly errorCode: ErrorCode
  readonly httpStatus: number
  constructor(message: string, errorCode: ErrorCode, httpStatus: number) {
    super(message)
    this.name = 'VssError'
    this.errorCode = errorCode
    this.httpStatus = httpStatus
  }
}

export class VssClient {
  #baseUrl: string
  #storeId: string
  #encryptionKey: Uint8Array
  #auth: VssHeaderProvider

  constructor(
    baseUrl: string,
    storeId: string,
    encryptionKey: Uint8Array,
    auth: VssHeaderProvider
  ) {
    this.#baseUrl = baseUrl
    this.#storeId = storeId
    this.#encryptionKey = encryptionKey
    this.#auth = auth
  }

  async getObject(key: string): Promise<{ value: Uint8Array; version: number } | null> {
    const obfuscatedKey = await obfuscateKey(this.#encryptionKey, key)

    const request = create(GetObjectRequestSchema, {
      storeId: this.#storeId,
      key: obfuscatedKey,
    })

    const res = await this.#post('getObject', toBinary(GetObjectRequestSchema, request))

    if (res.status === 404) return null
    if (!res.ok) throw await this.#parseError(res)

    const responseBytes = new Uint8Array(await res.arrayBuffer())
    const response = fromBinary(GetObjectResponseSchema, responseBytes)

    if (!response.value) return null

    const decrypted = vssDecrypt(this.#encryptionKey, response.value.value)
    return {
      value: decrypted,
      version: Number(response.value.version),
    }
  }

  /**
   * Write a single object. Returns the new version number.
   * The VSS protocol increments the server-side version by 1 on each successful write,
   * so the returned value is `version + 1`.
   */
  async putObject(key: string, value: Uint8Array, version: number): Promise<number> {
    const obfuscatedKey = await obfuscateKey(this.#encryptionKey, key)
    const encrypted = vssEncrypt(this.#encryptionKey, value)

    const kv = create(KeyValueSchema, {
      key: obfuscatedKey,
      version: BigInt(version),
      value: encrypted,
    })

    const request = create(PutObjectRequestSchema, {
      storeId: this.#storeId,
      transactionItems: [kv],
    })

    const res = await this.#post('putObjects', toBinary(PutObjectRequestSchema, request))
    if (!res.ok) throw await this.#parseError(res)
    return version + 1
  }

  async putObjects(
    items: Array<{ key: string; value: Uint8Array; version: number }>
  ): Promise<void> {
    const transactionItems: KeyValue[] = []
    for (const item of items) {
      const obfuscatedKey = await obfuscateKey(this.#encryptionKey, item.key)
      const encrypted = vssEncrypt(this.#encryptionKey, item.value)
      transactionItems.push(
        create(KeyValueSchema, {
          key: obfuscatedKey,
          version: BigInt(item.version),
          value: encrypted,
        })
      )
    }

    const request = create(PutObjectRequestSchema, {
      storeId: this.#storeId,
      transactionItems,
    })

    const res = await this.#post('putObjects', toBinary(PutObjectRequestSchema, request))
    if (!res.ok) throw await this.#parseError(res)
  }

  async deleteObject(key: string, version: number): Promise<void> {
    const obfuscatedKey = await obfuscateKey(this.#encryptionKey, key)

    const request = create(DeleteObjectRequestSchema, {
      storeId: this.#storeId,
      keyValue: create(KeyValueSchema, {
        key: obfuscatedKey,
        version: BigInt(version),
      }),
    })

    const res = await this.#post('deleteObject', toBinary(DeleteObjectRequestSchema, request))
    if (!res.ok) throw await this.#parseError(res)
  }

  async listKeyVersions(): Promise<Array<{ key: string; version: number }>> {
    const results: Array<{ key: string; version: number }> = []
    let pageToken: string | undefined
    let pages = 0

    do {
      if (++pages > MAX_LIST_PAGES) {
        throw new VssError('[VSS] listKeyVersions exceeded max page limit', ErrorCode.UNKNOWN, 0)
      }

      const request = create(ListKeyVersionsRequestSchema, {
        storeId: this.#storeId,
        pageToken,
      })

      const res = await this.#post(
        'listKeyVersions',
        toBinary(ListKeyVersionsRequestSchema, request)
      )
      if (!res.ok) throw await this.#parseError(res)

      const responseBytes = new Uint8Array(await res.arrayBuffer())
      const response = fromBinary(ListKeyVersionsResponseSchema, responseBytes)

      for (const kv of response.keyVersions) {
        results.push({ key: kv.key, version: Number(kv.version) })
      }

      pageToken = response.nextPageToken || undefined
    } while (pageToken)

    return results
  }

  async #post(endpoint: string, body: Uint8Array): Promise<Response> {
    try {
      return await fetch(`${this.#baseUrl}/${endpoint}`, {
        method: 'POST',
        body: body as unknown as BodyInit,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/octet-stream',
          ...(await this.#auth.getHeaders()),
        },
      })
    } catch (err) {
      throw new VssError(
        `[VSS] ${endpoint} network error: ${err instanceof Error ? err.message : String(err)}`,
        ErrorCode.UNKNOWN,
        0
      )
    }
  }

  async #parseError(res: Response): Promise<VssError> {
    try {
      const bytes = new Uint8Array(await res.arrayBuffer())
      const errorResponse = fromBinary(ErrorResponseSchema, bytes)
      return new VssError(`[VSS] ${errorResponse.message}`, errorResponse.errorCode, res.status)
    } catch {
      return new VssError(
        `[VSS] HTTP ${res.status}: ${res.statusText}`,
        ErrorCode.UNKNOWN,
        res.status
      )
    }
  }
}
