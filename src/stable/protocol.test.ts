import { beforeAll, describe, expect, it } from 'vitest'
import { UtilMethods, initializeWasmFromBinary } from 'lightningdevkit'
import { getPublicKey } from '@noble/secp256k1'
import { decodeProviderMessage, envelope, requestHash } from './protocol'

describe('Stable Channels signed wire messages (real WASM)', () => {
  const secret = new Uint8Array(32).fill(7)
  const provider = getPublicKey(secret)
  beforeAll(async () => {
    const fsModule = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsModule)) as {
      readFileSync(path: string): Uint8Array
    }
    await initializeWasmFromBinary(
      new Uint8Array(fs.readFileSync('node_modules/lightningdevkit/liblightningjs.wasm'))
    )
  })
  const verify = (bytes: Uint8Array, signature: string) =>
    UtilMethods.constructor_verify(bytes, signature, provider)
  const signed = (value: unknown) =>
    envelope(JSON.stringify(value), (bytes) => UtilMethods.constructor_sign(bytes, secret))
  const sync = {
    type: 'SYNC_V1',
    channel_id: '1'.repeat(64),
    expected_usd: 100,
    backing_sats: 999999,
    sync_version: 1,
  }
  it('accepts the upstream zbase32 signed-envelope format, ignoring peer backing', () => {
    expect(decodeProviderMessage(signed(sync), verify)).toEqual({
      kind: 'sync',
      channelId: sync.channel_id,
      expectedUsd: 100,
      version: 1n,
      correlation: null,
    })
  })
  it('rejects an attacker signature and altered raw payload', () => {
    const bytes = envelope(JSON.stringify(sync), (message) =>
      UtilMethods.constructor_sign(message, new Uint8Array(32).fill(8))
    )
    expect(() => decodeProviderMessage(bytes, verify)).toThrow(/signature/)
    const altered = new TextEncoder().encode(
      new TextDecoder().decode(signed(sync)).replace('100', '200')
    )
    expect(() => decodeProviderMessage(altered, verify)).toThrow(/signature/)
  })
  it('requires complete correlation and safe monotonic versions', () => {
    expect(() =>
      decodeProviderMessage(signed({ ...sync, trade_id: '2'.repeat(64) }), verify)
    ).toThrow()
    expect(() => decodeProviderMessage(signed({ ...sync, sync_version: 0 }), verify)).toThrow()
    expect(() =>
      decodeProviderMessage(signed({ ...sync, sync_version: Number.MAX_SAFE_INTEGER + 1 }), verify)
    ).toThrow()
  })
  it('hashes the exact request bytes, without reserializing', () => {
    expect(requestHash('{"type":"TRADE_V1"}')).not.toBe(requestHash('{ "type": "TRADE_V1" }'))
  })
  it('rejects oversized and unknown protocol messages', () => {
    expect(() => decodeProviderMessage(new Uint8Array(8193), verify)).toThrow(/large/)
    expect(() => decodeProviderMessage(signed({ ...sync, type: 'TRANSFER_ALL' }), verify)).toThrow()
  })
})
