import { describe, it, expect, vi, beforeEach } from 'vitest'
import { toBinary, fromBinary, create } from '@bufbuild/protobuf'
import { VssClient, FixedHeaderProvider, SignatureHeaderProvider, VssError } from './vss-client'
import {
  GetObjectResponseSchema,
  PutObjectRequestSchema,
  DeleteObjectRequestSchema,
  ListKeyVersionsRequestSchema,
  KeyValueSchema,
  ErrorResponseSchema,
  ErrorCode,
  ListKeyVersionsResponseSchema,
} from './proto/vss_pb'
import { vssEncrypt, obfuscateKey } from './vss-crypto'
import { getPublicKey, verify } from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha2.js'
import { hexToBytes } from '../utils'

/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-base-to-string */

const TEST_KEY = crypto.getRandomValues(new Uint8Array(32))
const TEST_STORE_ID = 'test-store'
const TEST_URL = 'https://vss.example.com/vss'

function makeClient(): VssClient {
  return new VssClient(
    TEST_URL,
    TEST_STORE_ID,
    TEST_KEY,
    new FixedHeaderProvider({ Authorization: 'Bearer test' })
  )
}

describe('VssClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('putObject', () => {
    it('sends a protobuf-encoded PutObjectRequest', async () => {
      let capturedBody: Uint8Array | null = null
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        expect(String(input)).toBe(`${TEST_URL}/putObjects`)
        capturedBody = new Uint8Array(init!.body as ArrayBuffer)
        return new Response(new Uint8Array(0), { status: 200 })
      })

      const client = makeClient()
      const newVersion = await client.putObject('my-key', new TextEncoder().encode('my-value'), 0)

      expect(newVersion).toBe(1)
      expect(capturedBody).not.toBeNull()

      // Verify the body is valid protobuf
      const decoded = fromBinary(PutObjectRequestSchema, capturedBody!)
      expect(decoded.storeId).toBe(TEST_STORE_ID)
      expect(decoded.transactionItems).toHaveLength(1)

      const firstItem = decoded.transactionItems[0]!
      expect(firstItem.version).toBe(0n)

      // Key should be obfuscated (64-char hex)
      expect(firstItem.key).toMatch(/^[0-9a-f]{64}$/)

      // Value should be encrypted (nonce + ciphertext + tag, not raw plaintext)
      expect(firstItem.value.length).toBeGreaterThan(new TextEncoder().encode('my-value').length)
    })

    it('includes auth headers', async () => {
      let capturedHeaders: Record<string, string> = {}
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        const headers = init!.headers as Record<string, string>
        capturedHeaders = headers
        return new Response(new Uint8Array(0), { status: 200 })
      })

      const client = makeClient()
      await client.putObject('k', new Uint8Array(1), 0)

      expect(capturedHeaders['Authorization']).toBe('Bearer test')
      expect(capturedHeaders['Content-Type']).toBe('application/octet-stream')
    })
  })

  describe('getObject', () => {
    it('returns null on 404', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }))

      const client = makeClient()
      const result = await client.getObject('nonexistent')
      expect(result).toBeNull()
    })

    it('decrypts the response value', async () => {
      const plaintext = new TextEncoder().encode('secret-data')
      const encrypted = vssEncrypt(TEST_KEY, plaintext)
      const obfuscated = await obfuscateKey(TEST_KEY, 'my-key')

      const responseMsg = create(GetObjectResponseSchema, {
        value: create(KeyValueSchema, {
          key: obfuscated,
          version: 3n,
          value: encrypted,
        }),
      })
      const responseBytes = toBinary(GetObjectResponseSchema, responseMsg)

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(responseBytes, { status: 200 }))

      const client = makeClient()
      const result = await client.getObject('my-key')

      expect(result).not.toBeNull()
      expect(result!.version).toBe(3)
      expect(Array.from(result!.value)).toEqual(Array.from(plaintext))
    })
  })

  describe('deleteObject', () => {
    it('sends a protobuf-encoded DeleteObjectRequest', async () => {
      let capturedUrl = ''
      let capturedBody: Uint8Array | null = null
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        capturedUrl = String(input)
        capturedBody = new Uint8Array(init!.body as ArrayBuffer)
        return new Response(new Uint8Array(0), { status: 200 })
      })

      const client = makeClient()
      await client.deleteObject('my-key', 3)

      expect(capturedUrl).toBe(`${TEST_URL}/deleteObject`)
      expect(capturedBody).not.toBeNull()

      const decoded = fromBinary(DeleteObjectRequestSchema, capturedBody!)
      expect(decoded.storeId).toBe(TEST_STORE_ID)
      expect(decoded.keyValue).toBeDefined()
      expect(decoded.keyValue!.key).toMatch(/^[0-9a-f]{64}$/)
      expect(decoded.keyValue!.version).toBe(3n)
    })

    it('throws on error response', async () => {
      const errorMsg = create(ErrorResponseSchema, {
        errorCode: ErrorCode.NO_SUCH_KEY_EXCEPTION,
        message: 'Key not found',
      })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(toBinary(ErrorResponseSchema, errorMsg), { status: 404 })
      )

      const client = makeClient()
      await expect(client.deleteObject('nonexistent', 1)).rejects.toThrow(VssError)
    })
  })

  describe('putObjects (batch)', () => {
    it('sends multiple items in a single request', async () => {
      let capturedBody: Uint8Array | null = null
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        capturedBody = new Uint8Array(init!.body as ArrayBuffer)
        return new Response(new Uint8Array(0), { status: 200 })
      })

      const client = makeClient()
      await client.putObjects([
        { key: 'key-a', value: new TextEncoder().encode('value-a'), version: 0 },
        { key: 'key-b', value: new TextEncoder().encode('value-b'), version: 1 },
        { key: 'key-c', value: new TextEncoder().encode('value-c'), version: 2 },
      ])

      expect(capturedBody).not.toBeNull()
      const decoded = fromBinary(PutObjectRequestSchema, capturedBody!)
      expect(decoded.storeId).toBe(TEST_STORE_ID)
      expect(decoded.transactionItems).toHaveLength(3)
      expect(decoded.transactionItems[0]!.version).toBe(0n)
      expect(decoded.transactionItems[1]!.version).toBe(1n)
      expect(decoded.transactionItems[2]!.version).toBe(2n)
    })
  })

  describe('error handling', () => {
    it('throws VssError with CONFLICT_EXCEPTION on 409', async () => {
      const errorMsg = create(ErrorResponseSchema, {
        errorCode: ErrorCode.CONFLICT_EXCEPTION,
        message: 'Version mismatch',
      })
      const errorBytes = toBinary(ErrorResponseSchema, errorMsg)

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(errorBytes.slice(), { status: 409 })
      })

      const client = makeClient()
      try {
        await client.putObject('k', new Uint8Array(1), 5)
        expect.unreachable('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(VssError)
        const error = e as VssError
        expect(error.errorCode).toBe(ErrorCode.CONFLICT_EXCEPTION)
        expect(error.httpStatus).toBe(409)
      }
    })

    it('throws VssError on network failure', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))

      const client = makeClient()
      await expect(client.getObject('k')).rejects.toThrow(VssError)
    })
  })

  describe('listKeyVersions', () => {
    it('returns all keys with pagination and forwards pageToken', async () => {
      const page1 = create(ListKeyVersionsResponseSchema, {
        keyVersions: [
          create(KeyValueSchema, { key: 'a', version: 1n }),
          create(KeyValueSchema, { key: 'b', version: 2n }),
        ],
        nextPageToken: 'page2',
      })
      const page2 = create(ListKeyVersionsResponseSchema, {
        keyVersions: [create(KeyValueSchema, { key: 'c', version: 3n })],
        nextPageToken: '',
      })

      let callCount = 0
      const capturedBodies: Uint8Array[] = []
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        callCount++
        capturedBodies.push(new Uint8Array(init!.body as ArrayBuffer))
        const data = callCount === 1 ? page1 : page2
        return new Response(toBinary(ListKeyVersionsResponseSchema, data), { status: 200 })
      })

      const client = makeClient()
      const results = await client.listKeyVersions()

      expect(results).toHaveLength(3)
      expect(results[0]).toEqual({ key: 'a', version: 1 })
      expect(results[2]).toEqual({ key: 'c', version: 3 })
      expect(callCount).toBe(2)

      // Verify pageToken was forwarded in the second request
      const secondRequest = fromBinary(ListKeyVersionsRequestSchema, capturedBodies[1]!)
      expect(secondRequest.pageToken).toBe('page2')
    })
  })
})

describe('FixedHeaderProvider', () => {
  it('returns the configured headers', async () => {
    const provider = new FixedHeaderProvider({ 'X-Custom': 'value' })
    const headers = await provider.getHeaders()
    expect(headers).toEqual({ 'X-Custom': 'value' })
  })
})

describe('SignatureHeaderProvider', () => {
  const secretKey = new Uint8Array(32).fill(42)

  it('returns an authorization header with correct format', async () => {
    const provider = new SignatureHeaderProvider(secretKey)
    const headers = await provider.getHeaders()
    const auth = headers['authorization']!

    // 66 hex chars (33-byte compressed pubkey) + 128 hex chars (64-byte compact sig) + timestamp digits
    expect(auth.length).toBeGreaterThan(66 + 128)
    const pubkeyHex = auth.slice(0, 66)
    const sigHex = auth.slice(66, 66 + 128)
    const timestamp = auth.slice(66 + 128)
    expect(pubkeyHex).toMatch(/^[0-9a-f]{66}$/)
    expect(sigHex).toMatch(/^[0-9a-f]{128}$/)
    expect(Number(timestamp)).toBeCloseTo(Math.floor(Date.now() / 1000), -1)
  })

  it('produces a verifiable ECDSA signature', async () => {
    const provider = new SignatureHeaderProvider(secretKey)
    const headers = await provider.getHeaders()
    const auth = headers['authorization']!

    const pubkeyHex = auth.slice(0, 66)
    const sigHex = auth.slice(66, 66 + 128)
    const timestamp = auth.slice(66 + 128)

    const pubkeyBytes = getPublicKey(secretKey, true)
    const signingConstant = new TextEncoder().encode(
      'VSS Signature Authorizer Signing Salt Constant..................'
    )
    const timestampBytes = new TextEncoder().encode(timestamp)
    const preimage = new Uint8Array(
      signingConstant.length + pubkeyBytes.length + timestampBytes.length
    )
    preimage.set(signingConstant, 0)
    preimage.set(pubkeyBytes, signingConstant.length)
    preimage.set(timestampBytes, signingConstant.length + pubkeyBytes.length)
    const hash = sha256(preimage)

    const sigBytes = hexToBytes(sigHex)

    expect(verify(sigBytes, hash, pubkeyBytes, { prehash: false })).toBe(true)
    // Pubkey in header matches derived pubkey
    expect(pubkeyHex).toBe(
      Array.from(pubkeyBytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    )
  })

  it('makes a defensive copy of the secret key', async () => {
    const key = new Uint8Array(32).fill(42)
    const provider = new SignatureHeaderProvider(key)
    key.fill(0) // mutate the original
    const headers = await provider.getHeaders()
    // Should still work with the original key value, not zeros
    expect(headers['authorization']!.length).toBeGreaterThan(66 + 128)
  })
})
