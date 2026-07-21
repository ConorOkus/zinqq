/**
 * Close records: persistent, facts-only history of channel closes.
 *
 * A record stores immutable facts (txids, heights, amounts) — never derived
 * state. Display status is computed by `deriveCloseStatus`; "needs deposit"
 * is derived from RecoveryState at render time and is never stored here.
 * Duplicate or out-of-order signals are no-ops on stored facts, which is
 * what makes event handling idempotent without a state machine.
 */

export interface Outpoint {
  txid: string
  vout: number
}

export type CloseTxRole = 'closing' | 'commitment' | 'anchor_cpfp' | 'htlc_claim' | 'sweep'

export interface CloseRecordTx {
  txid: string
  role: CloseTxRole
  feeSats?: bigint
  /** Write-once at first confirmation; live confirmation count is derived at render. */
  confirmedAtHeight?: number
}

export interface CloseRecord {
  /** Records live indefinitely and sync across app versions via VSS. */
  schemaVersion: number
  channelId: string
  fundingTxo?: Outpoint
  closeType: 'coop' | 'force' | 'unknown'
  initiator: 'local' | 'remote' | 'unknown'
  /** Raw ClosureReason variant description, display-only pass-through. */
  closureReason?: string
  /** Union by txid; one batched sweep txid may appear in N records. */
  txs: CloseRecordTx[]
  /** Estimate until complete; measured from wallet receipt at completion. */
  expectedAmountSats?: bigint
  /** Height at which timelocked funds become claimable. */
  claimableAtHeight?: number
  /** Stable history sort key; set at event time. */
  createdAt: number
  /** Set-once terminal marker. Only set on positive evidence (see reconcile). */
  completedAt?: number
  /** 'verified' = wallet receipt confirmed; 'unverified' = resolved without receipt evidence. */
  resolution?: 'verified' | 'unverified'
  /** Unknown fields from newer schema versions, preserved through decode → merge → encode. */
  extras?: Record<string, unknown>
}

export const CLOSE_RECORD_SCHEMA_VERSION = 1

/** Derived display status — pure function, never stored. */
export type CloseStatus =
  | 'closing'
  | 'waiting_timelock'
  | 'returning'
  | 'complete'
  | 'resolved_unverified'

export function deriveCloseStatus(record: CloseRecord, currentHeight: number | null): CloseStatus {
  if (record.completedAt !== undefined) {
    return record.resolution === 'unverified' ? 'resolved_unverified' : 'complete'
  }
  const sweep = record.txs.find((tx) => tx.role === 'sweep')
  if (sweep && sweep.confirmedAtHeight === undefined) return 'returning'
  if (
    record.claimableAtHeight !== undefined &&
    (currentHeight === null || record.claimableAtHeight > currentHeight)
  ) {
    return 'waiting_timelock'
  }
  if (sweep) return 'returning'
  return 'closing'
}

/**
 * Deterministic field-wise merge: `base` is the existing record, `incoming`
 * carries new facts. Identity facts are set-once (known beats unknown, never
 * downgrade); measurements (`expectedAmountSats`, `claimableAtHeight`) take
 * the incoming value when present (they legitimately update as HTLCs
 * resolve); `txs` union by txid with per-field fill-in; `completedAt` is
 * set-once with 'verified' resolution absorbing 'unverified'.
 */
export function mergeCloseRecords(base: CloseRecord, incoming: CloseRecord): CloseRecord {
  const txByTxid = new Map<string, CloseRecordTx>()
  for (const tx of base.txs) txByTxid.set(tx.txid, { ...tx })
  for (const tx of incoming.txs) {
    const existing = txByTxid.get(tx.txid)
    if (!existing) {
      txByTxid.set(tx.txid, { ...tx })
    } else {
      txByTxid.set(tx.txid, {
        txid: existing.txid,
        role: existing.role,
        feeSats: existing.feeSats ?? tx.feeSats,
        confirmedAtHeight: existing.confirmedAtHeight ?? tx.confirmedAtHeight,
      })
    }
  }

  const completedAt = base.completedAt ?? incoming.completedAt
  let resolution = base.resolution ?? incoming.resolution
  if (base.resolution === 'verified' || incoming.resolution === 'verified') {
    resolution = 'verified'
  }

  return {
    schemaVersion: Math.max(base.schemaVersion, incoming.schemaVersion),
    channelId: base.channelId,
    fundingTxo: base.fundingTxo ?? incoming.fundingTxo,
    closeType: incoming.closeType !== 'unknown' ? incoming.closeType : base.closeType,
    initiator: incoming.initiator !== 'unknown' ? incoming.initiator : base.initiator,
    closureReason: base.closureReason ?? incoming.closureReason,
    txs: Array.from(txByTxid.values()),
    expectedAmountSats: incoming.expectedAmountSats ?? base.expectedAmountSats,
    claimableAtHeight: incoming.claimableAtHeight ?? base.claimableAtHeight,
    createdAt: Math.min(base.createdAt, incoming.createdAt),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(resolution !== undefined ? { resolution } : {}),
    ...(base.extras || incoming.extras ? { extras: { ...incoming.extras, ...base.extras } } : {}),
  }
}

// --- Serialization -------------------------------------------------------
// The wire shape is shared by IDB and VSS and must be JSON-safe: the VSS
// path is JSON.stringify, which THROWS on bigint. One codec for both stores.

const KNOWN_RECORD_KEYS = new Set([
  'schemaVersion',
  'channelId',
  'fundingTxo',
  'closeType',
  'initiator',
  'closureReason',
  'txs',
  'expectedAmountSats',
  'claimableAtHeight',
  'createdAt',
  'completedAt',
  'resolution',
])

export function serializeCloseRecord(record: CloseRecord): Record<string, unknown> {
  const { extras, ...rest } = record
  return {
    ...extras, // unknown fields from newer schemas survive the round-trip
    ...rest,
    txs: record.txs.map((tx) => ({
      ...tx,
      feeSats: tx.feeSats !== undefined ? tx.feeSats.toString() : undefined,
    })),
    expectedAmountSats:
      record.expectedAmountSats !== undefined ? record.expectedAmountSats.toString() : undefined,
  }
}

function toBigIntOrUndefined(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value
  if (typeof value === 'string' && value !== '') {
    try {
      return BigInt(value)
    } catch {
      return undefined
    }
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  return undefined
}

/** Tolerant decode: unknown top-level fields are preserved in `extras`. */
export function deserializeCloseRecord(raw: unknown): CloseRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.channelId !== 'string') return null

  const extras: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (!KNOWN_RECORD_KEYS.has(key)) extras[key] = value
  }

  const rawTxs = Array.isArray(obj.txs) ? obj.txs : []
  const txs: CloseRecordTx[] = []
  for (const rawTx of rawTxs) {
    if (typeof rawTx !== 'object' || rawTx === null) continue
    const t = rawTx as Record<string, unknown>
    if (typeof t.txid !== 'string') continue
    txs.push({
      txid: t.txid,
      role: typeof t.role === 'string' ? (t.role as CloseTxRole) : 'closing',
      ...(toBigIntOrUndefined(t.feeSats) !== undefined
        ? { feeSats: toBigIntOrUndefined(t.feeSats) }
        : {}),
      ...(typeof t.confirmedAtHeight === 'number'
        ? { confirmedAtHeight: t.confirmedAtHeight }
        : {}),
    })
  }

  const fundingTxo =
    typeof obj.fundingTxo === 'object' && obj.fundingTxo !== null
      ? (obj.fundingTxo as { txid?: unknown; vout?: unknown })
      : null
  const closeType =
    obj.closeType === 'coop' || obj.closeType === 'force' ? obj.closeType : 'unknown'
  const initiator =
    obj.initiator === 'local' || obj.initiator === 'remote' ? obj.initiator : 'unknown'
  const expectedAmountSats = toBigIntOrUndefined(obj.expectedAmountSats)

  return {
    schemaVersion:
      typeof obj.schemaVersion === 'number' ? obj.schemaVersion : CLOSE_RECORD_SCHEMA_VERSION,
    channelId: obj.channelId,
    ...(fundingTxo && typeof fundingTxo.txid === 'string' && typeof fundingTxo.vout === 'number'
      ? { fundingTxo: { txid: fundingTxo.txid, vout: fundingTxo.vout } }
      : {}),
    closeType,
    initiator,
    ...(typeof obj.closureReason === 'string' ? { closureReason: obj.closureReason } : {}),
    txs,
    ...(expectedAmountSats !== undefined ? { expectedAmountSats } : {}),
    ...(typeof obj.claimableAtHeight === 'number'
      ? { claimableAtHeight: obj.claimableAtHeight }
      : {}),
    createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : Date.now(),
    ...(typeof obj.completedAt === 'number' ? { completedAt: obj.completedAt } : {}),
    ...(obj.resolution === 'verified' || obj.resolution === 'unverified'
      ? { resolution: obj.resolution }
      : {}),
    ...(Object.keys(extras).length > 0 ? { extras } : {}),
  }
}
