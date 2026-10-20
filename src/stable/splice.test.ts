import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Option_CVec_u8ZZ, Option_u16Z, Result_NoneAPIErrorZ, APIError } from 'lightningdevkit'
import { ScriptBuf, Transaction, Txid, type Wallet } from '@bitcoindevkit/bdk-wallet-web'
import { getPublicKey } from '@noble/secp256k1'
import { initializeTestLdk } from '../test/initialize-ldk-wasm'
import { bytesToHex, hexToBytes } from '../ldk/utils'
import type { LdkNode } from '../ldk/init'
import type { VssClient } from '../ldk/storage/vss-client'
import { clearAllStores, closeDb, idbGet } from '../storage/idb'
import {
  SpliceController,
  assertNoPendingSplice,
  isSpliceInputReserved,
  type SpliceState,
} from './splice'
import * as bitcoin from './splice-bitcoin'

vi.mock('../shared/fee-cache', () => ({ getFeeRate: () => Promise.resolve(2) }))
const provider = getPublicKey(new Uint8Array(32).fill(7))
const ownScript = '0014' + '11'.repeat(20)
const changeScript = '0014' + '22'.repeat(20)
const previous = hexToBytes(
  '0200000001' +
    '00'.repeat(32) +
    'ffffffff020101ffffffff01701101000000000016' +
    ownScript +
    '00000000'
)

function setup(vss: VssClient | null = null) {
  let alive = true
  const prev = Transaction.from_bytes(previous)
  const coinId = prev.compute_txid().toString()
  let channelId = 'a'.repeat(64)
  let fundingId = '1'.repeat(64)
  const channel = {
    get_channel_id: () => ({ write: () => hexToBytes(channelId) }),
    get_counterparty: () => ({ get_node_id: () => provider }),
    get_user_channel_id: () => 7n,
    get_is_usable: () => true,
    get_is_channel_ready: () => true,
    get_pending_inbound_htlcs: () => [],
    get_pending_outbound_htlcs: () => [],
    get_funding_txo: () => ({
      get_txid: () => hexToBytes(fundingId).reverse(),
      get_index: () => 0,
    }),
    get_funding_redeem_script: () => Option_CVec_u8ZZ.constructor_some(new Uint8Array(71).fill(1)),
    get_channel_value_satoshis: () => 10000n,
    get_force_close_spend_delay: () => Option_u16Z.constructor_none(),
  }
  const start = vi.fn(() => Result_NoneAPIErrorZ.constructor_ok())
  const sign = vi.fn(() => Result_NoneAPIErrorZ.constructor_ok())
  const node = {
    channelManager: {
      list_channels: () => [channel],
      splice_channel: start,
      funding_transaction_signed: sign,
    },
    peerManager: {
      list_peers: () => [
        {
          get_counterparty_node_id: () => provider,
          get_init_features: () => ({ supports_splicing_production: () => true }),
        },
      ],
      process_events: vi.fn(),
      disconnect_by_node_id: vi.fn(),
    },
  } as unknown as LdkNode
  const wallet = {
    list_unspent: () => [
      {
        outpoint: { txid: Txid.from_string(coinId), vout: 0, toString: () => `${coinId}:0` },
        txout: {
          script_pubkey: ScriptBuf.from_bytes(hexToBytes(ownScript)),
          value: { to_sat: () => 70000n },
        },
      },
    ],
    get_tx: () => ({
      chain_position: { is_confirmed: true },
      tx: Transaction.from_bytes(previous),
    }),
    next_unused_address: () => ({
      address: { script_pubkey: ScriptBuf.from_bytes(hexToBytes(changeScript)) },
    }),
    take_staged: () => undefined,
    apply_unconfirmed_txs: vi.fn(),
  } as unknown as Wallet
  const persist = vi.fn(() => Promise.resolve())
  const rebind = vi.fn(() => Promise.resolve())
  const allocateAll = vi.fn(async (before: () => Promise<void>) => {
    await before()
  })
  const deps = {
    node,
    wallet,
    providerId: bytesToHex(provider),
    vss,
    alive: () => alive,
    canStart: () => true,
    persistManager: persist,
    rebind,
    allocateAll,
  }
  return {
    controller: new SpliceController(deps),
    deps,
    start,
    sign,
    persist,
    rebind,
    allocateAll,
    coinId,
    deactivate: () => {
      alive = false
    },
    locked: () => {
      channelId = 'b'.repeat(64)
      fundingId = '2'.repeat(64)
    },
    fundingChanged: () => {
      fundingId = '3'.repeat(64)
    },
  }
}
beforeAll(initializeTestLdk)
beforeEach(async () => {
  vi.restoreAllMocks()
  closeDb()
  await clearAllStores()
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify({ spent: false }))))
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('mainnet channel funding lifecycle', () => {
  it('quotes the maximum after fees and reserve without starting funding', async () => {
    const f = setup()
    await f.controller.load()
    const quote = await f.controller.quoteMaximum()
    expect(quote.amountSats).toBe('59422')
    expect(quote.maxFeeSats).toBe('578')
    expect(70000n - BigInt(quote.amountSats) - BigInt(quote.maxFeeSats)).toBe(10000n)
    expect(f.start).not.toHaveBeenCalled()
    expect(isSpliceInputReserved(`${f.coinId}:0`)).toBe(false)
    await f.controller.commit(quote)
    expect(f.start).toHaveBeenCalledTimes(1)
  })
  it('accounts for extra inputs and avoids inputs that reduce the maximum', async () => {
    const f = setup()
    await f.controller.load()
    const coin = f.deps.wallet.list_unspent()[0]!
    vi.spyOn(f.deps.wallet, 'list_unspent').mockReturnValue(
      [40000n, 30000n, 1n].map((value, index) => ({
        ...coin,
        outpoint: { ...coin.outpoint, toString: () => `${f.coinId}:${index}` },
        txout: { ...coin.txout, value: { to_sat: () => value } },
      })) as unknown as ReturnType<Wallet['list_unspent']>
    )
    const quote = await f.controller.quoteMaximum()
    expect(quote.amountSats).toBe('59285')
    expect(quote.maxFeeSats).toBe('716')
    expect(quote.inputs).toHaveLength(2)
    expect(70001n - BigInt(quote.amountSats) - BigInt(quote.maxFeeSats)).toBe(10000n)
  })
  it('does not offer a maximum below the minimum or include unconfirmed funds', async () => {
    const f = setup()
    await f.controller.load()
    const coin = f.deps.wallet.list_unspent()[0]!
    vi.spyOn(f.deps.wallet, 'list_unspent').mockReturnValue([
      { ...coin, txout: { ...coin.txout, value: { to_sat: () => 11577n } } },
    ] as unknown as ReturnType<Wallet['list_unspent']>)
    await expect(f.controller.quoteMaximum()).rejects.toThrow(/Not enough confirmed/)
    vi.spyOn(f.deps.wallet, 'get_tx').mockReturnValue(undefined)
    await expect(f.controller.quoteMaximum()).rejects.toThrow(/Not enough confirmed/)
    expect(f.start).not.toHaveBeenCalled()
  })
  it('does not start mainnet funding if the wallet stops during backup persistence', async () => {
    const vss = { getObject: () => Promise.resolve(null), putObject: vi.fn() }
    const f = setup(vss as unknown as VssClient)
    await f.controller.load()
    const quote = await f.controller.quote(40000n)
    vss.putObject.mockImplementation(() => {
      f.deactivate()
      return Promise.resolve(1)
    })
    await expect(f.controller.commit(quote)).rejects.toThrow('Wallet stopped')
    expect(f.start).not.toHaveBeenCalled()
  })
  it('requires a new review if the funding output changes without a channel-id change', async () => {
    const f = setup()
    await f.controller.load()
    const quote = await f.controller.quote(40000n)
    f.fundingChanged()
    await expect(f.controller.commit(quote)).rejects.toThrow(/Channel changed/)
    expect(f.start).not.toHaveBeenCalled()
  })
  it('does not negotiate if the chain reports a reviewed input has already been spent', async () => {
    const f = setup()
    await f.controller.load()
    const quote = await f.controller.quote(40000n)
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ spent: true })))
    await expect(f.controller.commit(quote)).rejects.toThrow(/funds changed/)
    expect(f.start).not.toHaveBeenCalled()
  })
  it('can cancel an unsigned interrupted request without leaving its coins locked', async () => {
    const f = setup()
    await f.controller.load()
    await f.controller.commit(await f.controller.quote(40000n))
    await f.controller.cancelUnsigned()
    expect(f.controller.state?.status).toBe('failed')
    await expect(assertNoPendingSplice()).resolves.toBeUndefined()
    expect(isSpliceInputReserved(`${f.coinId}:0`)).toBe(false)
  })
  it('requires an issued, unchanged quote and reserves inputs before negotiating', async () => {
    const f = setup()
    await f.controller.load()
    const quote = await f.controller.quote(40000n)
    await expect(f.controller.commit({ ...quote, amountSats: '41000' })).rejects.toThrow(/review/i)
    expect(f.start).not.toHaveBeenCalled()
    await f.controller.commit(quote)
    expect(f.start).toHaveBeenCalledTimes(1)
    expect(isSpliceInputReserved(`${f.coinId}:0`)).toBe(true)
    await expect(assertNoPendingSplice()).rejects.toThrow(/adding funds/)
    const saved = await idbGet<SpliceState>('ldk_stable_channels', 'splice')
    expect(saved?.status).toBe('negotiating')
    await expect(f.controller.commit(quote)).rejects.toThrow(/fresh/)
    expect(f.start).toHaveBeenCalledTimes(1)
  })
  it('does not negotiate when the encrypted backup write fails', async () => {
    const f = setup({
      getObject: () => Promise.resolve(null),
      putObject: () => Promise.reject(new Error('Backup unavailable')),
    } as unknown as VssClient)
    await f.controller.load()
    const quote = await f.controller.quote(40000n)
    await expect(f.controller.commit(quote)).rejects.toThrow('Backup unavailable')
    expect(f.start).not.toHaveBeenCalled()
    expect(isSpliceInputReserved(`${f.coinId}:0`)).toBe(false)
  })
  it('recovers a pending splice after restart and allocates once after the funding output locks', async () => {
    const f = setup()
    await f.controller.load()
    await f.controller.commit(await f.controller.quote(40000n))
    await f.controller.handle({
      kind: 'pending',
      key: 'pending',
      userChannelId: '7',
      providerId: bytesToHex(provider),
      outpoint: '2'.repeat(64) + ':0',
    })
    f.controller.stop()
    const recovered = new SpliceController(f.deps)
    await recovered.load()
    await recovered.tick()
    expect(f.allocateAll).not.toHaveBeenCalled()
    f.locked()
    await recovered.tick()
    await recovered.tick()
    expect(recovered.state?.status).toBe('complete')
    expect(f.rebind).toHaveBeenCalledWith('a'.repeat(64), 'b'.repeat(64))
    expect(f.allocateAll).toHaveBeenCalledTimes(1)
    expect(isSpliceInputReserved(`${f.coinId}:0`)).toBe(false)
  })
  it('keeps inputs reserved unless LDK releases every contributed input', async () => {
    const f = setup()
    await f.controller.load()
    await f.controller.commit(await f.controller.quote(40000n))
    const event = {
      kind: 'failed' as const,
      key: 'fail',
      userChannelId: '7',
      providerId: bytesToHex(provider),
      inputs: [] as string[],
    }
    await expect(f.controller.handle(event)).rejects.toThrow(/not all/i)
    expect(isSpliceInputReserved(`${f.coinId}:0`)).toBe(true)
    await f.controller.handle({ ...event, inputs: [`${f.coinId}:0`] })
    expect(f.controller.state?.status).toBe('failed')
    expect(isSpliceInputReserved(`${f.coinId}:0`)).toBe(false)
  })
  it('retries persistence without submitting signatures twice after an interrupted write', async () => {
    const f = setup()
    await f.controller.load()
    await f.controller.commit(await f.controller.quote(40000n))
    const unsigned = hexToBytes(
      '0200000001' +
        bytesToHex(hexToBytes(f.coinId).reverse()) +
        '0000000000fdffffff01701101000000000016' +
        ownScript +
        '00000000'
    )
    vi.spyOn(bitcoin, 'signSpliceFunding').mockReturnValue(unsigned)
    f.persist.mockRejectedValueOnce(new Error('Persistence interrupted'))
    const event = {
      kind: 'sign' as const,
      key: 'sign',
      channelId: 'a'.repeat(64),
      userChannelId: '7',
      providerId: bytesToHex(provider),
      unsigned,
    }
    await expect(f.controller.handle(event)).rejects.toThrow(/interrupted/)
    await f.controller.handle(event)
    expect(f.sign).toHaveBeenCalledTimes(1)
    expect(f.controller.state?.signedTx).toBe(bytesToHex(unsigned))
    f.controller.stop()
    const restarted = new SpliceController(f.deps)
    await restarted.load()
    f.sign.mockReturnValue(
      Result_NoneAPIErrorZ.constructor_err(
        APIError.constructor_apimisuse_error(
          `Channel with id ${'a'.repeat(64)} not expecting funding signatures`
        )
      )
    )
    await expect(restarted.handle(event)).resolves.toBeUndefined()
    expect(restarted.state?.signedTx).toBe(bytesToHex(unsigned))
  })
})
