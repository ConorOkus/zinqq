import { useMemo } from 'react'
import { useOnchain } from '../onchain/use-onchain'
import { useLdk } from '../ldk/use-ldk'
import { msatToSatFloor } from '../utils/msat'
import { useCloseRecords, useLastKnownTipHeight } from '../ldk/close-records/use-close-records'
import { deriveCloseStatus, type CloseStatus } from '../ldk/close-records/close-record'

interface UnifiedTransactionBase {
  id: string
  direction: 'sent' | 'received'
  timestamp: number // unix ms for sorting
  status: 'confirmed' | 'pending' | 'failed'
}

export type UnifiedTransaction =
  | (UnifiedTransactionBase & { layer: 'onchain'; amountSats: bigint })
  | (UnifiedTransactionBase & { layer: 'lightning'; amountSats: bigint })
  | (UnifiedTransactionBase & {
      layer: 'channel-close'
      /** Null while unknown — render "—", never a lying "0 sats". */
      amountSats: bigint | null
      channelId: string
      closeStatus: CloseStatus
    })

export function useTransactionHistory(): {
  transactions: UnifiedTransaction[]
  isLoading: boolean
} {
  const onchain = useOnchain()
  const ldk = useLdk()
  const closeRecords = useCloseRecords()
  const tipHeight = useLastKnownTipHeight()

  const isLoading = onchain.status === 'loading' || ldk.status === 'loading'

  // Extract granular deps so the memo doesn't recompute on unrelated context changes
  // (sync status, channel counter, etc.)
  const listTransactions = onchain.status === 'ready' ? onchain.listTransactions : null
  const onchainBalance = onchain.status === 'ready' ? onchain.balance : null
  const paymentHistory = ldk.status === 'ready' ? ldk.paymentHistory : null

  const transactions = useMemo(() => {
    const items: UnifiedTransaction[] = []

    // Absorption: on-chain txs that belong to a close (commitment, sweep,
    // closing) render inside the grouped close item, never double-listed as
    // bare receives. Set built from the SAME records snapshot that emits the
    // close rows — two snapshots would double-display for one render.
    const absorbedTxids = new Set(closeRecords.flatMap((r) => r.txs.map((tx) => tx.txid)))

    // On-chain transactions
    if (listTransactions) {
      for (const tx of listTransactions()) {
        if (absorbedTxids.has(tx.txid)) continue
        const netSent = tx.sent - tx.received
        const netReceived = tx.received - tx.sent
        const isSend = tx.sent > tx.received
        items.push({
          id: tx.txid,
          direction: isSend ? 'sent' : 'received',
          amountSats: isSend ? netSent : netReceived,
          timestamp: tx.confirmationTime
            ? Number(tx.confirmationTime) * 1000
            : tx.firstSeen
              ? Number(tx.firstSeen) * 1000
              : 0,
          status: tx.isConfirmed ? 'confirmed' : 'pending',
          layer: 'onchain',
        })
      }
    }

    // Lightning payments from persisted history
    if (paymentHistory) {
      for (const p of paymentHistory) {
        if (p.status === 'failed') continue
        items.push({
          id: p.paymentHash,
          direction: p.direction === 'outbound' ? 'sent' : 'received',
          amountSats: msatToSatFloor(p.amountMsat),
          timestamp: p.createdAt,
          status: p.status === 'pending' ? 'pending' : 'confirmed',
          layer: 'lightning',
        })
      }
    }

    // Channel closes: one grouped item per record
    for (const record of closeRecords) {
      const closeStatus = deriveCloseStatus(record, tipHeight)
      items.push({
        id: `close:${record.channelId}`,
        direction: 'received',
        amountSats: record.expectedAmountSats ?? null,
        timestamp: record.createdAt, // stable sort key — rows must not hop as facts arrive
        status:
          closeStatus === 'complete' || closeStatus === 'resolved_unverified'
            ? 'confirmed'
            : 'pending',
        layer: 'channel-close',
        channelId: record.channelId,
        closeStatus,
      })
    }

    items.sort((a, b) => b.timestamp - a.timestamp)
    return items
    // onchainBalance is included as a recomputation signal — when balance changes
    // after a sync tick, new transactions may be available from listTransactions().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listTransactions, onchainBalance, paymentHistory, closeRecords, tipHeight])

  return { transactions, isLoading }
}
