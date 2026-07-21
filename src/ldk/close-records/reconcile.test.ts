import { describe, it, expect, vi, beforeEach } from 'vitest'

const idbData = new Map<string, unknown>()
vi.mock('../../storage/idb', () => ({
  idbGet: vi.fn((_store: string, key: string) => Promise.resolve(idbData.get(key))),
  idbPut: vi.fn((_store: string, key: string, value: unknown) => {
    idbData.set(key, value)
    return Promise.resolve()
  }),
  idbGetAll: vi.fn(() => Promise.resolve(new Map())),
}))

vi.mock('../storage/vss-client', () => ({
  isVssConflict: () => false,
}))

vi.mock('../../storage/error-log', () => ({
  captureError: vi.fn(),
}))

vi.mock('@bitcoindevkit/bdk-wallet-web', () => ({
  Txid: { from_string: (s: string) => s },
}))

import { reconcileCloseRecords, type ReconcileDeps } from './reconcile'
import {
  initCloseRecords,
  upsertCloseRecord,
  getCloseRecordSync,
  recordFundingTxo,
  resetCloseRecordsForTest,
} from './store'
import { CLOSE_RECORD_SCHEMA_VERSION, type CloseRecord } from './close-record'

const TIP = { tipChanged: true, tipHash: 'tiphash' }
const TIP_HEIGHT = 1000

function record(channelId: string, overrides: Partial<CloseRecord> = {}): CloseRecord {
  return {
    schemaVersion: CLOSE_RECORD_SCHEMA_VERSION,
    channelId,
    closeType: 'force',
    initiator: 'local',
    txs: [],
    createdAt: 1,
    ...overrides,
  }
}

interface DepsOptions {
  openChannelIds?: string[]
  outspends?: Record<string, { spent: boolean; txid?: string }>
  txStatuses?: Record<string, { confirmed: boolean; block_height?: number }>
  walletTxids?: string[]
  esploraFails?: boolean
}

function makeDeps(opts: DepsOptions = {}): ReconcileDeps {
  const fail = () => Promise.reject(new Error('esplora down'))
  return {
    channelManager: {
      list_channels: () =>
        (opts.openChannelIds ?? []).map((id) => ({
          get_channel_id: () => ({
            write: () => Uint8Array.from(id.match(/../g)!.map((b) => parseInt(b, 16))),
          }),
        })),
    } as never,
    esplora: {
      getBlockHeight: opts.esploraFails ? fail : () => Promise.resolve(TIP_HEIGHT),
      getOutspend: opts.esploraFails
        ? fail
        : (txid: string, vout: number) =>
            Promise.resolve(opts.outspends?.[`${txid}:${String(vout)}`] ?? { spent: false }),
      getTxStatus: opts.esploraFails
        ? fail
        : (txid: string) => Promise.resolve(opts.txStatuses?.[txid] ?? { confirmed: false }),
    } as never,
    bdkWallet: {
      get_tx: (txid: unknown) =>
        (opts.walletTxids ?? []).includes(txid as string)
          ? { chain_position: { is_confirmed: true } }
          : undefined,
    } as never,
  }
}

beforeEach(async () => {
  idbData.clear()
  resetCloseRecordsForTest()
  await initCloseRecords(null)
})

describe('reconcileCloseRecords', () => {
  it('does nothing when no close is pending (zero steady-state cost)', async () => {
    const deps = makeDeps()
    const heightSpy = vi.spyOn(deps.esplora, 'getBlockHeight')
    await reconcileCloseRecords(deps, TIP)
    expect(heightSpy).not.toHaveBeenCalled()
  })

  it('creates records for channels that vanished recordless (funding-txo map diff)', async () => {
    await recordFundingTxo('dead', { txid: 'f0', vout: 0 })
    await reconcileCloseRecords(makeDeps({ openChannelIds: [] }), TIP)

    const created = getCloseRecordSync('dead')
    expect(created).toBeDefined()
    expect(created?.fundingTxo).toEqual({ txid: 'f0', vout: 0 })
    expect(created?.closeType).toBe('unknown')
  })

  it('does not create records for channels that are still open', async () => {
    await recordFundingTxo('ab', { txid: 'f0', vout: 0 })
    await reconcileCloseRecords(makeDeps({ openChannelIds: ['ab'] }), TIP)
    expect(getCloseRecordSync('ab')).toBeUndefined()
  })

  it('discovers the closing tx from the funding outspend', async () => {
    await upsertCloseRecord(record('ab', { fundingTxo: { txid: 'f0', vout: 1 } }))
    await reconcileCloseRecords(
      makeDeps({
        outspends: { 'f0:1': { spent: true, txid: 'commit-tx' } },
        txStatuses: { 'commit-tx': { confirmed: true, block_height: 990 } },
      }),
      TIP
    )
    const tx = getCloseRecordSync('ab')?.txs.find((t) => t.txid === 'commit-tx')
    expect(tx?.role).toBe('commitment')
    expect(tx?.confirmedAtHeight).toBe(990)
  })

  it('checks undiscovered closing txs even without a new tip (mempool window)', async () => {
    await upsertCloseRecord(record('ab', { fundingTxo: { txid: 'f0', vout: 1 } }))
    await reconcileCloseRecords(
      makeDeps({ outspends: { 'f0:1': { spent: true, txid: 'commit-tx' } } }),
      { tipChanged: false, tipHash: 'tiphash' }
    )
    expect(getCloseRecordSync('ab')?.txs.some((t) => t.txid === 'commit-tx')).toBe(true)
  })

  it('completes verified on wallet receipt evidence (≥6 confs + in BDK wallet)', async () => {
    await upsertCloseRecord(
      record('ab', {
        expectedAmountSats: 5000n,
        txs: [{ txid: 'sweep-tx', role: 'sweep', confirmedAtHeight: TIP_HEIGHT - 10 }],
      })
    )
    await reconcileCloseRecords(makeDeps({ walletTxids: ['sweep-tx'] }), TIP)
    const r = getCloseRecordSync('ab')
    expect(r?.completedAt).toBeDefined()
    expect(r?.resolution).toBe('verified')
  })

  it('does NOT complete on confirmations alone when funds never reached our wallet', async () => {
    await upsertCloseRecord(
      record('ab', {
        expectedAmountSats: 5000n,
        claimableAtHeight: TIP_HEIGHT + 100, // timelock still pending
        txs: [{ txid: 'commit-tx', role: 'commitment', confirmedAtHeight: TIP_HEIGHT - 50 }],
      })
    )
    await reconcileCloseRecords(makeDeps(), TIP)
    expect(getCloseRecordSync('ab')?.completedAt).toBeUndefined()
  })

  it('completes verified when there was nothing to receive (expected 0, close final)', async () => {
    await upsertCloseRecord(
      record('ab', {
        expectedAmountSats: 0n,
        txs: [{ txid: 'commit-tx', role: 'commitment', confirmedAtHeight: TIP_HEIGHT - 10 }],
      })
    )
    await reconcileCloseRecords(makeDeps(), TIP)
    const r = getCloseRecordSync('ab')
    expect(r?.completedAt).toBeDefined()
    expect(r?.resolution).toBe('verified')
  })

  it('marks resolved-unverified when the coop close is final but the wallet never saw funds', async () => {
    await upsertCloseRecord(
      record('ab', {
        closeType: 'coop',
        expectedAmountSats: 5000n,
        txs: [{ txid: 'close-tx', role: 'closing', confirmedAtHeight: TIP_HEIGHT - 10 }],
      })
    )
    await reconcileCloseRecords(makeDeps(), TIP)
    const r = getCloseRecordSync('ab')
    expect(r?.completedAt).toBeDefined()
    expect(r?.resolution).toBe('unverified')
  })

  it('Esplora failure leaves the record stale — never completes it', async () => {
    await upsertCloseRecord(
      record('ab', {
        expectedAmountSats: 0n,
        fundingTxo: { txid: 'f0', vout: 1 },
        txs: [{ txid: 'commit-tx', role: 'commitment', confirmedAtHeight: TIP_HEIGHT - 10 }],
      })
    )
    await reconcileCloseRecords(makeDeps({ esploraFails: true }), TIP)
    expect(getCloseRecordSync('ab')?.completedAt).toBeUndefined()
  })

  it('completed records are quiescent — no queries for them', async () => {
    await upsertCloseRecord(
      record('ab', {
        fundingTxo: { txid: 'f0', vout: 1 },
        completedAt: 123,
        resolution: 'verified',
      })
    )
    const deps = makeDeps()
    const outspendSpy = vi.spyOn(deps.esplora, 'getOutspend')
    await reconcileCloseRecords(deps, TIP)
    expect(outspendSpy).not.toHaveBeenCalled()
  })
})
