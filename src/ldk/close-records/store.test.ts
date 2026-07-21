import { describe, it, expect, vi, beforeEach } from 'vitest'

const idbData = new Map<string, unknown>()
vi.mock('../../storage/idb', () => ({
  idbGet: vi.fn((_store: string, key: string) => Promise.resolve(idbData.get(key))),
  idbPut: vi.fn((_store: string, key: string, value: unknown) => {
    idbData.set(key, value)
    return Promise.resolve()
  }),
}))

vi.mock('../storage/vss-client', () => ({
  isVssConflict: (err: unknown) => err instanceof Error && err.message === 'CONFLICT',
}))

vi.mock('../../storage/error-log', () => ({
  captureError: vi.fn(),
}))

import {
  initCloseRecords,
  upsertCloseRecord,
  getCloseRecordSync,
  getCloseRecordsSnapshot,
  recordFundingTxo,
  getFundingTxoMap,
  resetCloseRecordsForTest,
  CLOSE_RECORDS_CHANGED_EVENT,
} from './store'
import { CLOSE_RECORD_SCHEMA_VERSION, type CloseRecord } from './close-record'
import type { VssClient } from '../storage/vss-client'

function record(channelId: string, overrides: Partial<CloseRecord> = {}): CloseRecord {
  return {
    schemaVersion: CLOSE_RECORD_SCHEMA_VERSION,
    channelId,
    closeType: 'force',
    initiator: 'local',
    txs: [],
    createdAt: 1000,
    ...overrides,
  }
}

function fakeVss(overrides: Partial<Record<'getObject' | 'putObject', unknown>> = {}): VssClient {
  return {
    getObject: vi.fn(() => Promise.resolve(null)),
    putObject: vi.fn(() => Promise.resolve(1)),
    ...overrides,
  } as never
}

beforeEach(() => {
  idbData.clear()
  resetCloseRecordsForTest()
})

describe('close-records store', () => {
  it('upsert updates the sync read model synchronously (BumpTransaction fires in the same drain)', () => {
    void upsertCloseRecord(record('ab', { expectedAmountSats: 500n }))
    expect(getCloseRecordSync('ab')?.expectedAmountSats).toBe(500n)
  })

  it('persists to IDB and survives re-init', async () => {
    await initCloseRecords(null)
    await upsertCloseRecord(record('ab', { txs: [{ txid: 't1', role: 'commitment' }] }))

    resetCloseRecordsForTest()
    await initCloseRecords(null)
    expect(getCloseRecordSync('ab')?.txs[0]?.txid).toBe('t1')
  })

  it('merges rather than replaces on repeated upserts', async () => {
    await upsertCloseRecord(record('ab', { txs: [{ txid: 't1', role: 'commitment' }] }))
    await upsertCloseRecord(record('ab', { closeType: 'unknown', txs: [{ txid: 't2', role: 'sweep' }] }))
    const merged = getCloseRecordSync('ab')
    expect(merged?.txs).toHaveLength(2)
    expect(merged?.closeType).toBe('force') // never downgraded by the 'unknown' upsert
  })

  it('dispatches the payload-less changed event after persist', async () => {
    const listener = vi.fn()
    window.addEventListener(CLOSE_RECORDS_CHANGED_EVENT, listener)
    await upsertCloseRecord(record('ab'))
    expect(listener).toHaveBeenCalled()
    window.removeEventListener(CLOSE_RECORDS_CHANGED_EVENT, listener)
  })

  it('init merges VSS state into local (cross-device restore)', async () => {
    const remoteMap = {
      cd: {
        schemaVersion: 1,
        channelId: 'cd',
        closeType: 'coop',
        initiator: 'remote',
        txs: [{ txid: 'remote-t', role: 'closing' }],
        createdAt: 42,
      },
    }
    const vss = fakeVss({
      getObject: vi.fn(() =>
        Promise.resolve({ version: 7, value: new TextEncoder().encode(JSON.stringify(remoteMap)) })
      ),
    })
    await initCloseRecords(vss)
    expect(getCloseRecordSync('cd')?.txs[0]?.txid).toBe('remote-t')
  })

  it('VSS conflict fetches remote and merges field-wise — both devices’ facts survive', async () => {
    // Device B (remote) knows the sweep txid; we (local) know the commitment fee.
    const remoteMap = {
      ab: {
        schemaVersion: 1,
        channelId: 'ab',
        closeType: 'force',
        initiator: 'local',
        txs: [{ txid: 'sweep-t', role: 'sweep' }],
        createdAt: 900,
      },
    }
    let putCalls = 0
    const vss = fakeVss({
      getObject: vi.fn(() =>
        Promise.resolve({ version: 5, value: new TextEncoder().encode(JSON.stringify(remoteMap)) })
      ),
      putObject: vi.fn(() => {
        putCalls += 1
        if (putCalls === 1) return Promise.reject(new Error('CONFLICT'))
        return Promise.resolve(6)
      }),
    })
    resetCloseRecordsForTest()
    idbData.clear()
    // init with null so the initial getObject doesn't consume the mock; then set client via init
    await initCloseRecords(null)
    // manually attach vss by re-initing with the fake (getObject consumed once here)
    resetCloseRecordsForTest()
    await initCloseRecords(vss)

    await upsertCloseRecord(
      record('ab', { txs: [{ txid: 'commit-t', role: 'commitment', feeSats: 2000n }] })
    )

    const merged = getCloseRecordSync('ab')
    const txids = merged?.txs.map((t) => t.txid).sort()
    expect(txids).toEqual(['commit-t', 'sweep-t'])
    expect(putCalls).toBeGreaterThanOrEqual(2)
  })

  it('VSS outage never blocks the local record (IDB-first)', async () => {
    const vss = fakeVss({
      getObject: vi.fn(() => Promise.reject(new Error('offline'))),
      putObject: vi.fn(() => Promise.reject(new Error('offline'))),
    })
    await initCloseRecords(vss)
    await upsertCloseRecord(record('ab'))
    expect(getCloseRecordSync('ab')).toBeDefined()
    expect(idbData.get('records')).toBeDefined()
  })

  it('funding-txo map persists and reloads', async () => {
    await initCloseRecords(null)
    await recordFundingTxo('ab', { txid: 'f0', vout: 1 })

    resetCloseRecordsForTest()
    await initCloseRecords(null)
    expect(getFundingTxoMap().get('ab')).toEqual({ txid: 'f0', vout: 1 })
  })

  it('snapshot is newest-first and referentially stable between mutations', async () => {
    await upsertCloseRecord(record('old', { createdAt: 100 }))
    await upsertCloseRecord(record('new', { createdAt: 200 }))
    const snap1 = getCloseRecordsSnapshot()
    const snap2 = getCloseRecordsSnapshot()
    expect(snap1).toBe(snap2)
    expect(snap1.map((r) => r.channelId)).toEqual(['new', 'old'])
  })
})
