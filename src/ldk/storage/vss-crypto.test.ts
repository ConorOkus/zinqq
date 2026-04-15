import { describe, it, expect } from 'vitest'
import { vssEncrypt, vssDecrypt, obfuscateKey } from './vss-crypto'

describe('vssEncrypt / vssDecrypt', () => {
  const key = crypto.getRandomValues(new Uint8Array(32))

  it('round-trips plaintext through encrypt then decrypt', () => {
    const plaintext = new TextEncoder().encode('hello world')
    const cipherBlob = vssEncrypt(key, plaintext)
    const decrypted = vssDecrypt(key, cipherBlob)
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext))
  })

  it('produces different ciphertext for the same plaintext (random nonce)', () => {
    const plaintext = new TextEncoder().encode('same input')
    const blob1 = vssEncrypt(key, plaintext)
    const blob2 = vssEncrypt(key, plaintext)
    // Nonces should differ, so blobs should differ
    expect(Array.from(blob1)).not.toEqual(Array.from(blob2))
    // But both should decrypt to the same plaintext
    expect(Array.from(vssDecrypt(key, blob1))).toEqual(Array.from(plaintext))
    expect(Array.from(vssDecrypt(key, blob2))).toEqual(Array.from(plaintext))
  })

  it('fails to decrypt with the wrong key', () => {
    const plaintext = new TextEncoder().encode('secret')
    const cipherBlob = vssEncrypt(key, plaintext)
    const wrongKey = crypto.getRandomValues(new Uint8Array(32))
    expect(() => vssDecrypt(wrongKey, cipherBlob)).toThrow()
  })

  it('fails on truncated ciphertext', () => {
    expect(() => vssDecrypt(key, new Uint8Array(10))).toThrow('too short')
  })

  it('handles empty plaintext', () => {
    const plaintext = new Uint8Array(0)
    const cipherBlob = vssEncrypt(key, plaintext)
    const decrypted = vssDecrypt(key, cipherBlob)
    expect(decrypted).toHaveLength(0)
  })

  it('handles large plaintext', () => {
    // crypto.getRandomValues has a 65536-byte limit, so fill in chunks
    const plaintext = new Uint8Array(100_000)
    for (let i = 0; i < plaintext.length; i += 65536) {
      const chunk = plaintext.subarray(i, Math.min(i + 65536, plaintext.length))
      crypto.getRandomValues(chunk)
    }
    const cipherBlob = vssEncrypt(key, plaintext)
    const decrypted = vssDecrypt(key, cipherBlob)
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext))
  })

  it('throws on wrong-length key', () => {
    const shortKey = new Uint8Array(16)
    const longKey = new Uint8Array(64)
    const plaintext = new TextEncoder().encode('test')
    expect(() => vssEncrypt(shortKey, plaintext)).toThrow('Key must be exactly 32 bytes')
    expect(() => vssEncrypt(longKey, plaintext)).toThrow('Key must be exactly 32 bytes')
    expect(() => vssDecrypt(shortKey, new Uint8Array(40))).toThrow('Key must be exactly 32 bytes')
  })

  it('cipherBlob is nonce (12 bytes) + ciphertext + tag (16 bytes)', () => {
    const plaintext = new Uint8Array(50)
    const cipherBlob = vssEncrypt(key, plaintext)
    // nonce(12) + plaintext(50) + tag(16) = 78
    expect(cipherBlob.length).toBe(12 + 50 + 16)
  })
})

describe('obfuscateKey', () => {
  const encryptionKey = crypto.getRandomValues(new Uint8Array(32))

  it('returns a 64-character hex string (SHA-256 output)', async () => {
    const result = await obfuscateKey(encryptionKey, 'test-key')
    expect(result).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic (same input → same output)', async () => {
    const result1 = await obfuscateKey(encryptionKey, 'my-key')
    const result2 = await obfuscateKey(encryptionKey, 'my-key')
    expect(result1).toBe(result2)
  })

  it('produces different hashes for different keys', async () => {
    const result1 = await obfuscateKey(encryptionKey, 'key-a')
    const result2 = await obfuscateKey(encryptionKey, 'key-b')
    expect(result1).not.toBe(result2)
  })

  it('produces different hashes with different encryption keys', async () => {
    const otherKey = crypto.getRandomValues(new Uint8Array(32))
    const result1 = await obfuscateKey(encryptionKey, 'same-key')
    const result2 = await obfuscateKey(otherKey, 'same-key')
    expect(result1).not.toBe(result2)
  })
})
