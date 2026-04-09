import { useParams, useLocation } from 'react-router'
import { useTransactionHistory, type UnifiedTransaction } from '../hooks/use-transaction-history'
import { formatBtc } from '../utils/format-btc'
import { ScreenHeader } from '../components/ScreenHeader'
import { ArrowUpRight, ArrowDownLeft } from '../components/icons'

function formatDate(timestamp: number): string {
  if (timestamp === 0) return 'Pending'
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(timestamp))
}

function formatTime(timestamp: number): string {
  if (timestamp === 0) return 'Pending'
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp))
}

function statusLabel(status: UnifiedTransaction['status']): string {
  switch (status) {
    case 'confirmed':
      return 'Complete'
    case 'pending':
      return 'Pending'
    case 'failed':
      return 'Failed'
  }
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-3">
      <span className="text-[var(--color-on-dark-muted)]">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  )
}

export function TransactionDetail() {
  const { txId } = useParams<{ txId: string }>()
  const location = useLocation()
  const { transactions, isLoading } = useTransactionHistory()

  // Fast path: transaction passed via router state
  const stateTx = (location.state as { tx?: UnifiedTransaction } | null)?.tx
  // Fallback: look up by id from transaction history
  const tx = stateTx ?? transactions.find((t) => t.id === txId)

  if (!tx && isLoading) {
    return (
      <div className="flex min-h-dvh flex-col bg-dark text-on-dark">
        <ScreenHeader title="Payment Details" backTo="/activity" />
        <div className="flex flex-1 items-center justify-center">
          <p className="text-[var(--color-on-dark-muted)]">Loading...</p>
        </div>
      </div>
    )
  }

  if (!tx) {
    return (
      <div className="flex min-h-dvh flex-col bg-dark text-on-dark">
        <ScreenHeader title="Payment Details" backTo="/activity" />
        <div className="flex flex-1 items-center justify-center">
          <p className="text-[var(--color-on-dark-muted)]">Transaction not found</p>
        </div>
      </div>
    )
  }

  const isSent = tx.direction === 'sent'

  return (
    <div className="flex min-h-dvh flex-col bg-dark text-on-dark">
      <ScreenHeader title="Payment Details" backTo="/activity" />

      {/* Hero: direction + amount */}
      <div className="flex flex-col items-center gap-2 px-6 pb-6 pt-8">
        <div className="flex items-center gap-2 text-[var(--color-on-dark-muted)]">
          {isSent ? (
            <ArrowUpRight className="h-5 w-5" aria-hidden="true" />
          ) : (
            <ArrowDownLeft className="h-5 w-5" aria-hidden="true" />
          )}
          <span className="text-lg font-semibold">{isSent ? 'Sent' : 'Received'}</span>
        </div>
        <div className="font-display text-4xl font-bold">
          {isSent ? '-' : '+'}
          {formatBtc(tx.amountSats)}
        </div>
      </div>

      {/* Divider */}
      <div className="mx-6 border-t border-white/10" />

      {/* Detail rows */}
      <div className="flex flex-col px-6 pt-2">
        <DetailRow label="Date" value={formatDate(tx.timestamp)} />
        <DetailRow label="Time" value={formatTime(tx.timestamp)} />
        <DetailRow label="Status" value={statusLabel(tx.status)} />
        <DetailRow label="Type" value={tx.layer === 'lightning' ? 'Lightning' : 'On-chain'} />
      </div>
    </div>
  )
}
