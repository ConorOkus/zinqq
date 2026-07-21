import { describe, it, expect } from 'vitest'
import {
  type CloseRecord,
  CLOSE_RECORD_SCHEMA_VERSION,
  mergeCloseRecords,
  serializeCloseRecord,
  deserializeCloseRecord,
  deriveCloseStatus,
} from './close-record'

function record(overrides: Partial<CloseRecord> = {}): CloseRecord {
  return {
    schemaVersion: CLOSE_RECORD_SCHEMA_VERSION,
    channelId: 'ab',
    closeType: 'unknown',
    initiator: 'unknown',
    txs: [],
    createdAt: 1000,
    ...overrides,
  }
}

describe('mergeCloseRecords', () => {
  it('unions txs by txid with per-field fill-in', () => {
    const base = record({ txs: [{ txid: 't1', role: 'commitment', feeSats: 2000n }] })
    const incoming = record({
      txs: [
        { txid: 't1', role: 'commitment', confirmedAtHeight: 100 },
        { txid: 't2', role: 'sweep' },
      ],
    })
    const merged = mergeCloseRecords(base, incoming)
    expect(merged.txs).toHaveLength(2)
    const t1 = merged.txs.find((t) => t.txid === 't1')
    expect(t1?.feeSats).toBe(2000n)
    expect(t1?.confirmedAtHeight).toBe(100)
  })

  it('known beats unknown for closeType/initiator; never downgrades', () => {
    const base = record({ closeType: 'force', initiator: 'local' })
    const incoming = record({ closeType: 'unknown', initiator: 'unknown' })
    const merged = mergeCloseRecords(base, incoming)
    expect(merged.closeType).toBe('force')
    expect(merged.initiator).toBe('local')
  })

  it('takes min createdAt (stable history sort key)', () => {
    expect(mergeCloseRecords(record({ createdAt: 500 }), record({ createdAt: 900 })).createdAt).toBe(
      500
    )
    expect(mergeCloseRecords(record({ createdAt: 900 }), record({ createdAt: 500 })).createdAt).toBe(
      500
    )
  })

  it('completedAt is set-once and verified resolution absorbs unverified', () => {
    const done = record({ completedAt: 2000, resolution: 'unverified' })
    const laterVerified = record({ completedAt: 3000, resolution: 'verified' })
    const merged = mergeCloseRecords(done, laterVerified)
    expect(merged.completedAt).toBe(2000)
    expect(merged.resolution).toBe('verified')
  })

  it('duplicate merges are no-ops on stored facts (idempotency)', () => {
    const base = record({
      closeType: 'coop',
      fundingTxo: { txid: 'f', vout: 0 },
      txs: [{ txid: 't1', role: 'closing' }],
      expectedAmountSats: 5000n,
    })
    const once = mergeCloseRecords(base, base)
    const twice = mergeCloseRecords(once, base)
    expect(twice).toEqual(once)
  })

  it('measurements update from incoming; identity facts are set-once', () => {
    const base = record({
      closureReason: 'Cooperative close',
      expectedAmountSats: 5000n,
      claimableAtHeight: 100,
    })
    const incoming = record({
      closureReason: 'something else',
      expectedAmountSats: 4800n,
      claimableAtHeight: 105,
    })
    const merged = mergeCloseRecords(base, incoming)
    expect(merged.closureReason).toBe('Cooperative close')
    expect(merged.expectedAmountSats).toBe(4800n)
    expect(merged.claimableAtHeight).toBe(105)
  })
})

describe('serialization', () => {
  it('round-trips through JSON without throwing on bigint', () => {
    const original = record({
      closeType: 'force',
      fundingTxo: { txid: 'f0', vout: 1 },
      txs: [{ txid: 't1', role: 'sweep', feeSats: 123n, confirmedAtHeight: 7 }],
      expectedAmountSats: 480_000n,
      claimableAtHeight: 900_000,
      completedAt: 5000,
      resolution: 'verified',
    })
    const json = JSON.stringify(serializeCloseRecord(original))
    const decoded = deserializeCloseRecord(JSON.parse(json))
    expect(decoded).toEqual(original)
  })

  it('preserves unknown fields from newer schema versions through decode → merge → encode', () => {
    const rawFromFutureVersion = {
      ...serializeCloseRecord(record()),
      schemaVersion: 2,
      futureField: { nested: true },
    }
    const decoded = deserializeCloseRecord(rawFromFutureVersion)
    expect(decoded).not.toBeNull()
    const merged = mergeCloseRecords(decoded!, record({ txs: [{ txid: 't9', role: 'sweep' }] }))
    const reEncoded = serializeCloseRecord(merged)
    expect(reEncoded.futureField).toEqual({ nested: true })
    expect(reEncoded.schemaVersion).toBe(2)
  })

  it('tolerates garbage input', () => {
    expect(deserializeCloseRecord(null)).toBeNull()
    expect(deserializeCloseRecord('nope')).toBeNull()
    expect(deserializeCloseRecord({})).toBeNull()
    expect(deserializeCloseRecord({ channelId: 'ab', txs: 'not-an-array' })).not.toBeNull()
  })
})

describe('deriveCloseStatus', () => {
  it('completedAt → complete (or resolved_unverified)', () => {
    expect(deriveCloseStatus(record({ completedAt: 1, resolution: 'verified' }), 100)).toBe(
      'complete'
    )
    expect(deriveCloseStatus(record({ completedAt: 1, resolution: 'unverified' }), 100)).toBe(
      'resolved_unverified'
    )
  })

  it('unconfirmed sweep → returning', () => {
    expect(deriveCloseStatus(record({ txs: [{ txid: 's', role: 'sweep' }] }), 100)).toBe(
      'returning'
    )
  })

  it('future claimable height → waiting_timelock', () => {
    expect(deriveCloseStatus(record({ claimableAtHeight: 200 }), 100)).toBe('waiting_timelock')
    expect(deriveCloseStatus(record({ claimableAtHeight: 200 }), null)).toBe('waiting_timelock')
  })

  it('past claimable height without sweep → closing', () => {
    expect(deriveCloseStatus(record({ claimableAtHeight: 50 }), 100)).toBe('closing')
  })

  it('confirmed sweep, not yet complete → returning', () => {
    expect(
      deriveCloseStatus(
        record({ claimableAtHeight: 50, txs: [{ txid: 's', role: 'sweep', confirmedAtHeight: 90 }] }),
        100
      )
    ).toBe('returning')
  })
})
