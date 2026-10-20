import { describe, it, expect } from 'vitest'
import { HDKey } from '@scure/bip32'
import { Transaction, UnconfirmedTx, Wallet } from '@bitcoindevkit/bdk-wallet-web'
import { bytesToHex, hexToBytes } from '../ldk/utils'
import { signSpliceFunding, validateSpliceFunding, type SpliceFunding } from './splice-bitcoin'

function amount(n: bigint): string {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, n, true)
  return bytesToHex(bytes)
}
function output(value: bigint, script: string): string {
  return amount(value) + (script.length / 2).toString(16).padStart(2, '0') + script
}
function previous(value: bigint, script: string): Transaction {
  return Transaction.from_bytes(
    hexToBytes(
      '0200000001' +
        '00'.repeat(32) +
        'ffffffff020101ffffffff01' +
        output(value, script) +
        '00000000'
    )
  )
}
function fixture() {
  const key = HDKey.fromMasterSeed(new Uint8Array(32).fill(7)).privateExtendedKey
  const wallet = Wallet.create('bitcoin', `wpkh(${key}/0/*)`, `wpkh(${key}/1/*)`)
  const ours = bytesToHex(wallet.next_unused_address('external').address.script_pubkey.as_bytes())
  const change = bytesToHex(wallet.next_unused_address('internal').address.script_pubkey.as_bytes())
  const script = '0020' + '42'.repeat(32)
  const nextScript = '0020' + '43'.repeat(32)
  const coin = previous(70_000n, ours),
    funding = previous(10_000n, script)
  wallet.apply_unconfirmed_txs([new UnconfirmedTx(coin.clone(), 1n)])
  const input = (tx: Transaction) =>
    bytesToHex(hexToBytes(tx.compute_txid().toString()).reverse()) + '0000000000fdffffff'
  const unsigned = (
    changeValue = 29_000n,
    fundingValue = 50_000n,
    fundingScript = nextScript,
    additionalOutput?: { value: bigint; script: string }
  ) =>
    hexToBytes(
      '0200000002' +
        input(coin) +
        input(funding) +
        (additionalOutput ? '03' : '02') +
        output(fundingValue, fundingScript) +
        output(changeValue, change) +
        (additionalOutput ? output(additionalOutput.value, additionalOutput.script) : '') +
        '00000000'
    )
  const reviewed: SpliceFunding = {
    amountSats: '40000',
    maxFeeSats: '1500',
    fundingOutpoint: `${funding.compute_txid().toString()}:0`,
    channelValueSats: '10000',
    fundingScript: script,
    changeScript: change,
    inputs: [
      {
        outpoint: `${coin.compute_txid().toString()}:0`,
        value: '70000',
        previousTx: bytesToHex(coin.to_bytes()),
      },
    ],
  }
  return { wallet, unsigned, reviewed, previous: [coin.to_bytes(), funding.to_bytes()] }
}
describe('splice transaction signing with real BDK', () => {
  it('signs LDK funding requests with rotated funding keys while preserving the reviewed increase', () => {
    const f = fixture()
    const unsigned = f.unsigned(29_000n, 50_000n, '0020' + '43'.repeat(32))
    const raw = signSpliceFunding(f.wallet, unsigned, f.previous, f.reviewed)
    const signed = Transaction.from_bytes(raw)
    expect(signed.compute_txid().toString()).toBe(
      Transaction.from_bytes(unsigned).compute_txid().toString()
    )
    expect(signed.input[0]!.total_size).toBeGreaterThan(signed.input[0]!.base_size)
    expect(signed.input[1]!.total_size).toBe(signed.input[1]!.base_size + 1)
  })
  it('still rejects underfunding or excessive fees with rotated funding keys', () => {
    const f = fixture()
    const rotated = '0020' + '43'.repeat(32)
    expect(() =>
      signSpliceFunding(f.wallet, f.unsigned(39_000n, 40_000n, rotated), f.previous, f.reviewed)
    ).toThrow(/reviewed amount/)
    expect(() =>
      signSpliceFunding(f.wallet, f.unsigned(20_000n, 50_000n, rotated), f.previous, f.reviewed)
    ).toThrow(/fee/)
  })
  it('rejects ambiguous or missing P2WSH funding outputs instead of guessing', () => {
    const f = fixture()
    expect(() =>
      signSpliceFunding(
        f.wallet,
        f.unsigned(29_000n, 50_000n, '0020' + '43'.repeat(32), {
          value: 1000n,
          script: '0020' + '44'.repeat(32),
        }),
        f.previous,
        f.reviewed
      )
    ).toThrow(/unambiguous P2WSH/)
    expect(() =>
      signSpliceFunding(
        f.wallet,
        f.unsigned(29_000n, 50_000n, '0014' + '43'.repeat(20)),
        f.previous,
        f.reviewed
      )
    ).toThrow(/unambiguous P2WSH/)
  })
  it('authenticates the old funding script and value on the shared input', () => {
    const f = fixture()
    for (const changed of [
      { fundingScript: '0020' + '43'.repeat(32) },
      { channelValueSats: '9999' },
    ]) {
      expect(() =>
        signSpliceFunding(f.wallet, f.unsigned(), f.previous, { ...f.reviewed, ...changed })
      ).toThrow(/shared input differs/)
    }
  })
  it('signs only the wallet input of a shared funding transaction, with SIGHASH_ALL', () => {
    const f = fixture()
    const raw = signSpliceFunding(f.wallet, f.unsigned(), f.previous, f.reviewed)
    const signed = Transaction.from_bytes(raw)
    expect(signed.compute_txid().toString()).toBe(
      Transaction.from_bytes(f.unsigned()).compute_txid().toString()
    )
    expect(signed.input[0]!.total_size).toBeGreaterThan(signed.input[0]!.base_size)
    expect(signed.input[1]!.total_size).toBe(signed.input[1]!.base_size + 1)
    // Final witness contains an ECDSA signature ending in SIGHASH_ALL (01).
    expect(bytesToHex(raw)).toMatch(/01(?:21(?:02|03)[0-9a-f]{64})0000000000$/)
  })
  it('rejects a peer consuming more than the reviewed fee before signing', () => {
    const f = fixture()
    expect(() => signSpliceFunding(f.wallet, f.unsigned(20_000n), f.previous, f.reviewed)).toThrow(
      /fee/
    )
  })
  it('rejects a transaction which does not increase channel funding by the approved amount', () => {
    const f = fixture()
    expect(() =>
      signSpliceFunding(f.wallet, f.unsigned(39_000n, 40_000n), f.previous, f.reviewed)
    ).toThrow(/reviewed amount/)
  })
  it('rejects substituted previous transactions', () => {
    const f = fixture()
    expect(() =>
      validateSpliceFunding(f.unsigned(), [f.previous[1]!, f.previous[0]!], f.reviewed, () => true)
    ).toThrow(/hash mismatch/)
  })
  it('refuses to sign an unapproved wallet input even when the transaction otherwise matches', () => {
    const f = fixture()
    expect(() =>
      signSpliceFunding(f.wallet, f.unsigned(), f.previous, { ...f.reviewed, inputs: [] })
    ).toThrow(/unapproved wallet input/)
  })
})
