import { describe, it, expect } from 'vitest'
import { closeConfirmedForAllChannels } from './recovery-reconcile'
import type { CloseRecord, CloseRecordTx } from '../close-records/close-record'
import { CLOSE_RECORD_SCHEMA_VERSION } from '../close-records/close-record'

function makeRecord(channelId: string, txs: CloseRecordTx[]): CloseRecord {
  return {
    schemaVersion: CLOSE_RECORD_SCHEMA_VERSION,
    channelId,
    closeType: 'force',
    initiator: 'unknown',
    txs,
    createdAt: 1,
  }
}

function lookup(records: CloseRecord[]): (id: string) => CloseRecord | undefined {
  return (id) => records.find((r) => r.channelId === id)
}

describe('closeConfirmedForAllChannels', () => {
  it('true when every channel has a confirmed closing tx', () => {
    const records = [
      makeRecord('aa', [{ txid: 't1', role: 'closing', confirmedAtHeight: 100 }]),
      makeRecord('bb', [{ txid: 't2', role: 'commitment', confirmedAtHeight: 101 }]),
    ]
    expect(closeConfirmedForAllChannels(['aa', 'bb'], lookup(records))).toBe(true)
  })

  it('true for a counterparty commitment confirmed after a restore (the false-positive case)', () => {
    // Our own commitment is stuck unconfirmed, but the counterparty's
    // commitment confirmed — the channel is closed, CPFP is moot.
    const records = [
      makeRecord('aa', [
        { txid: 'ours', role: 'commitment' },
        { txid: 'theirs', role: 'commitment', confirmedAtHeight: 959_000 },
      ]),
    ]
    expect(closeConfirmedForAllChannels(['aa'], lookup(records))).toBe(true)
  })

  it('true when the record completed via sweep receipt (no confirmed close tx recorded)', () => {
    const record = makeRecord('aa', [{ txid: 'ours', role: 'commitment' }])
    record.completedAt = 123
    record.resolution = 'verified'
    expect(closeConfirmedForAllChannels(['aa'], lookup([record]))).toBe(true)
  })

  it('false while the close tx is unconfirmed (deposit genuinely needed)', () => {
    const records = [makeRecord('aa', [{ txid: 't1', role: 'commitment' }])]
    expect(closeConfirmedForAllChannels(['aa'], lookup(records))).toBe(false)
  })

  it('false when only non-close txs are confirmed', () => {
    const records = [
      makeRecord('aa', [
        { txid: 't1', role: 'commitment' },
        { txid: 't2', role: 'sweep', confirmedAtHeight: 100 },
      ]),
    ]
    expect(closeConfirmedForAllChannels(['aa'], lookup(records))).toBe(false)
  })

  it('false when any channel is missing its record (conservative)', () => {
    const records = [makeRecord('aa', [{ txid: 't1', role: 'closing', confirmedAtHeight: 100 }])]
    expect(closeConfirmedForAllChannels(['aa', 'missing'], lookup(records))).toBe(false)
  })

  it('false for an empty channel list', () => {
    expect(closeConfirmedForAllChannels([], lookup([]))).toBe(false)
  })
})
