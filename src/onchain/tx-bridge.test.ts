import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractTxBytes, broadcastTransaction } from './tx-bridge'
import { Transaction, p2wpkh, TEST_NETWORK } from '@scure/btc-signer'
import { HDKey } from '@scure/bip32'
import { hexToBytes } from '../ldk/utils'

// Derive a key pair from a well-known seed for deterministic test vectors
const TEST_SEED = hexToBytes(
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
)
const hdkey = HDKey.fromMasterSeed(TEST_SEED)
const child = hdkey.derive("m/84'/1'/0'/0/0")
const TEST_PRIVKEY = child.privateKey!
const TEST_PUBKEY = child.publicKey!

function createTestPsbtBase64(): { psbtBase64: string; expectedTxBytes: Uint8Array } {
  const payment = p2wpkh(TEST_PUBKEY, TEST_NETWORK)
  const tx = new Transaction()
  tx.addInput({
    txid: '0000000000000000000000000000000000000000000000000000000000000001',
    index: 0,
    witnessUtxo: {
      script: payment.script,
      amount: BigInt(50_000),
    },
  })
  tx.addOutputAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', BigInt(40_000), TEST_NETWORK)
  tx.sign(TEST_PRIVKEY)

  // Capture the signed (but not yet finalized) PSBT — this is what BDK's psbt.toString() produces
  const psbtBase64 = bytesToBase64(tx.toPSBT())

  // Now finalize and extract to get expected raw tx bytes
  tx.finalize()
  const expectedTxBytes = tx.extract()

  return { psbtBase64, expectedTxBytes }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

describe('tx-bridge', () => {
  describe('extractTxBytes', () => {
    it('extracts raw transaction bytes from a finalized PSBT', () => {
      const { psbtBase64, expectedTxBytes } = createTestPsbtBase64()
      const result = extractTxBytes(psbtBase64)
      expect(Array.from(result)).toEqual(Array.from(expectedTxBytes))
    })

    it('throws on invalid base64', () => {
      expect(() => extractTxBytes('not-valid-base64!!!')).toThrow()
    })
  })

  describe('broadcastTransaction', () => {
    beforeEach(() => {
      vi.restoreAllMocks()
    })

    it('posts tx hex to esplora /tx and returns txid', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('abc123txid'),
      })
      vi.stubGlobal('fetch', mockFetch)

      const txid = await broadcastTransaction('deadbeef', 'https://example.com/api')

      expect(mockFetch).toHaveBeenCalledWith('https://example.com/api/tx', {
        method: 'POST',
        body: 'deadbeef',
      })
      expect(txid).toBe('abc123txid')
    })

    it('returns sentinel for already-in-chain response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          text: () => Promise.resolve('Transaction already in block chain'),
        }),
      )

      const result = await broadcastTransaction('deadbeef', 'https://example.com/api')
      expect(result).toBe('already-broadcast')
    })

    it('returns sentinel for txn-already-known response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          text: () => Promise.resolve('txn-already-known'),
        }),
      )

      const result = await broadcastTransaction('deadbeef', 'https://example.com/api')
      expect(result).toBe('already-broadcast')
    })

    it('throws on non-ok response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          text: () => Promise.resolve('bad tx'),
        }),
      )

      await expect(
        broadcastTransaction('bad', 'https://example.com/api'),
      ).rejects.toThrow('Esplora broadcast failed: 400 bad tx')
    })
  })
})
