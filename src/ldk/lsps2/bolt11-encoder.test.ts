import { describe, it, expect } from 'vitest'
import { encodeBolt11Invoice, parseLsps2Scid, type RouteHintEntry } from './bolt11-encoder'
import * as secp256k1 from '@noble/secp256k1'

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
})
