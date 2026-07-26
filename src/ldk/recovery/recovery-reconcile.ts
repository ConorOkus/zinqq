import type { CloseRecord } from '../close-records/close-record'

/**
 * True when every channel in a recovery state has a CONFIRMED closing or
 * commitment transaction in its close record.
 *
 * Recovery exists to collect a deposit for anchor-CPFP fees on an
 * unconfirmed force-close commitment. Once ANY closing tx for the channel
 * confirms — ours (fees turned out sufficient) or the counterparty's (our
 * commitment is superseded and can never confirm) — the CPFP is moot and the
 * deposit ask is wrong. Close records heal from chain truth via
 * `reconcileCloseRecords`, so this converges even for records created after
 * a restore. Timelocked/sweeping funds from a confirmed close are tracked by
 * the close records themselves; they need no deposit.
 *
 * A COMPLETED record also counts: completion requires positive evidence
 * (wallet receipt, or timelock-expired terminal resolution), either of which
 * means the close resolved without our deposit.
 *
 * Missing records or unconfirmed close txs keep recovery active
 * (conservative: never clear a deposit ask we can't disprove).
 */
export function closeConfirmedForAllChannels(
  channelIds: string[],
  getRecord: (channelId: string) => CloseRecord | undefined
): boolean {
  if (channelIds.length === 0) return false
  return channelIds.every((channelId) => {
    const record = getRecord(channelId)
    if (!record) return false
    if (record.completedAt !== undefined) return true
    return record.txs.some(
      (tx) =>
        (tx.role === 'closing' || tx.role === 'commitment') && tx.confirmedAtHeight !== undefined
    )
  })
}
