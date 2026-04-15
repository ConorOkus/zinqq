import { describe, it, expect } from 'vitest'
import { encodeBolt11Invoice, parseLsps2Scid, type RouteHintEntry } from './bolt11-encoder'
import * as secp256k1 from '@noble/secp256k1'
import { bech32 } from '@scure/base'

// Generate a test keypair
const testPrivateKey = new Uint8Array(32)
testPrivateKey[31] = 1 // minimal valid private key
const testPubkey = new Uint8Array(secp256k1.getPublicKey(testPrivateKey, true))

describe('parseLsps2Scid', () => {
  it('parses standard format', () => {
    // block=1, tx=2, output=3
    const scid = parseLsps2Scid('1x2x3')
    expect(scid).toBe((1n << 40n) | (2n << 16n) | 3n)
  })

  it('parses larger values', () => {
    const scid = parseLsps2Scid('29451x4815x1')
    expect(scid).toBe((29451n << 40n) | (4815n << 16n) | 1n)
  })

  it('handles whitespace in parts', () => {
    const scid = parseLsps2Scid(' 1 x 2 x 3 ')
    expect(scid).toBe((1n << 40n) | (2n << 16n) | 3n)
  })

  it('throws on invalid format', () => {
    expect(() => parseLsps2Scid('1x2')).toThrow('Invalid SCID')
    expect(() => parseLsps2Scid('abc')).toThrow('Invalid SCID')
  })
})

describe('encodeBolt11Invoice', () => {
  const paymentHash = new Uint8Array(32)
  paymentHash[0] = 0xab
  const paymentSecret = new Uint8Array(32)
  paymentSecret[0] = 0xcd

  const lspPubkey = new Uint8Array(33)
  lspPubkey[0] = 0x02
  lspPubkey[32] = 0x01

  it('produces a valid bech32 string starting with lntbs', async () => {
    const invoice = await encodeBolt11Invoice(
      {
        amountMsat: 100_000n,
        paymentHash,
        paymentSecret,
        description: 'test',
        expirySecs: 3600,
        minFinalCltvExpiry: 144,
        payeeNodeId: testPubkey,
        routeHints: [],
        timestamp: 1700000000,
      },
      testPrivateKey
    )

    expect(invoice).toMatch(/^lntbs/)
    expect(invoice.length).toBeGreaterThan(50)
  })

  it('includes amount in HRP', async () => {
    // 100_000 msat = 1 micro-BTC (100_000 msat * 10 pico/msat = 1_000_000 pico = 1u)
    const invoice = await encodeBolt11Invoice(
      {
        amountMsat: 100_000n,
        paymentHash,
        paymentSecret,
        description: 'test',
        expirySecs: 3600,
        minFinalCltvExpiry: 144,
        payeeNodeId: testPubkey,
        routeHints: [],
        timestamp: 1700000000,
      },
      testPrivateKey
    )

    // 100_000 msat = 1_000_000 pico-BTC = 10u
    expect(invoice.startsWith('lntbs1u')).toBe(true)
  })

  it('encodes with route hints', async () => {
    const routeHint: RouteHintEntry = {
      pubkey: lspPubkey,
      shortChannelId: (100n << 40n) | (200n << 16n) | 1n,
      feeBaseMsat: 0,
      feeProportionalMillionths: 0,
      cltvExpiryDelta: 144,
    }

    const invoice = await encodeBolt11Invoice(
      {
        amountMsat: 50_000_000n,
        paymentHash,
        paymentSecret,
        description: 'jit channel payment',
        expirySecs: 3600,
        minFinalCltvExpiry: 146,
        payeeNodeId: testPubkey,
        routeHints: [[routeHint]],
        timestamp: 1700000000,
      },
      testPrivateKey
    )

    expect(invoice).toMatch(/^lntbs/)
    // Invoice with route hints should be longer than without
    expect(invoice.length).toBeGreaterThan(100)
  })

  it('produces different invoices for different amounts', async () => {
    const base = {
      paymentHash,
      paymentSecret,
      description: 'test',
      expirySecs: 3600,
      minFinalCltvExpiry: 144,
      payeeNodeId: testPubkey,
      routeHints: [] as RouteHintEntry[][],
      timestamp: 1700000000,
    }

    const invoice1 = await encodeBolt11Invoice({ ...base, amountMsat: 100_000n }, testPrivateKey)
    const invoice2 = await encodeBolt11Invoice({ ...base, amountMsat: 200_000n }, testPrivateKey)
    expect(invoice1).not.toBe(invoice2)
  })

  it('produces different invoices for different payment hashes', async () => {
    const base = {
      amountMsat: 100_000n,
      paymentSecret,
      description: 'test',
      expirySecs: 3600,
      minFinalCltvExpiry: 144,
      payeeNodeId: testPubkey,
      routeHints: [] as RouteHintEntry[][],
      timestamp: 1700000000,
    }

    const hash2 = new Uint8Array(32)
    hash2[0] = 0xff

    const invoice1 = await encodeBolt11Invoice({ ...base, paymentHash }, testPrivateKey)
    const invoice2 = await encodeBolt11Invoice({ ...base, paymentHash: hash2 }, testPrivateKey)
    expect(invoice1).not.toBe(invoice2)
  })

  it('decodes to correct fields when independently parsed (cross-validation)', async () => {
    const routeHint: RouteHintEntry = {
      pubkey: lspPubkey,
      shortChannelId: (100n << 40n) | (200n << 16n) | 1n,
      feeBaseMsat: 1000,
      feeProportionalMillionths: 100,
      cltvExpiryDelta: 144,
    }

    const invoice = await encodeBolt11Invoice(
      {
        amountMsat: 50_000_000n,
        paymentHash,
        paymentSecret,
        description: 'cross-validation test',
        expirySecs: 3600,
        minFinalCltvExpiry: 146,
        payeeNodeId: testPubkey,
        routeHints: [[routeHint]],
        timestamp: 1700000000,
      },
      testPrivateKey
    )

    // --- Independent decoder using @scure/base bech32 ---
    const { prefix: hrp, words } = bech32.decode(invoice as `${string}1${string}`, 2000)

    // Verify HRP: 50_000_000 msat = 500_000_000 pico-BTC = 500u
    expect(hrp).toBe('lntbs500u')

    // Convert 5-bit words to bytes; when padRemaining is true, leftover bits
    // are shifted into a final byte (matching the encoder's signing preimage)
    function wordsToBytes(w: number[], padRemaining = false): Uint8Array {
      const result: number[] = []
      let bits = 0
      let value = 0
      for (const word of w) {
        value = (value << 5) | (word & 0x1f)
        bits += 5
        while (bits >= 8) {
          bits -= 8
          result.push((value >>> bits) & 0xff)
        }
      }
      if (padRemaining && bits > 0) {
        result.push((value << (8 - bits)) & 0xff)
      }
      return new Uint8Array(result)
    }

    // Skip timestamp (7 words), then parse tagged fields
    let pos = 7

    // Signature is last 104 words (65 bytes in 5-bit = ceil(65*8/5) = 104)
    const dataWords = Array.from(words.slice(0, words.length - 104))
    const sigWords = Array.from(words.slice(words.length - 104))

    const fields: Map<number, number[]> = new Map()
    while (pos < dataWords.length) {
      const tag = dataWords[pos]!
      const len = (dataWords[pos + 1]! << 5) | dataWords[pos + 2]!
      const data = dataWords.slice(pos + 3, pos + 3 + len)
      if (!fields.has(tag)) fields.set(tag, data)
      pos += 3 + len
    }

    // Verify payment hash (tag 1, 32 bytes)
    const decodedHash = wordsToBytes(fields.get(1)!)
    expect(Array.from(decodedHash.slice(0, 32))).toEqual(Array.from(paymentHash))

    // Verify payment secret (tag 16, 32 bytes)
    const decodedSecret = wordsToBytes(fields.get(16)!)
    expect(Array.from(decodedSecret.slice(0, 32))).toEqual(Array.from(paymentSecret))

    // Verify description (tag 13)
    const decodedDesc = new TextDecoder().decode(wordsToBytes(fields.get(13)!))
    expect(decodedDesc).toBe('cross-validation test')

    // Verify payee node ID (tag 19, 33 bytes)
    const decodedPayee = wordsToBytes(fields.get(19)!)
    expect(Array.from(decodedPayee.slice(0, 33))).toEqual(Array.from(testPubkey))

    // Verify signature is valid (65 bytes = 64-byte compact sig + 1 recovery byte)
    const sigBytes = wordsToBytes(sigWords)
    const compactSig = sigBytes.slice(0, 64)
    const recoveryByte = sigBytes[64]

    // Reconstruct the signing preimage: sha256(hrp_bytes || data_bytes_with_padding)
    const hrpBytes = new TextEncoder().encode(hrp)
    const dataBytes = wordsToBytes(dataWords, true)
    const preimage = new Uint8Array(hrpBytes.length + dataBytes.length)
    preimage.set(hrpBytes)
    preimage.set(dataBytes, hrpBytes.length)
    const hashBuffer = await crypto.subtle.digest('SHA-256', preimage)
    const messageHash = new Uint8Array(hashBuffer)

    const isValid = secp256k1.verify(compactSig, messageHash, testPubkey, { prehash: false })
    expect(isValid).toBe(true)
    expect(recoveryByte).toBeLessThanOrEqual(3)
  })
})
