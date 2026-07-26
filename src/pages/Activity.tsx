import { Link } from 'react-router'
import { useTransactionHistory } from '../hooks/use-transaction-history'
import { formatBtc } from '../utils/format-btc'
import { ArrowUpRight, ArrowDownLeft } from '../components/icons'
import type { CloseStatus } from '../ldk/close-records/close-record'

const CLOSE_BADGES: Record<CloseStatus, string> = {
  closing: 'Closing',
  waiting_timelock: 'Waiting timelock',
  returning: 'Returning to wallet',
  complete: '',
  resolved_unverified: 'Resolved',
}

function formatRelativeTime(timestamp: number): string {
  if (timestamp === 0) return ''
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'Just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  return `${weeks}w ago`
}

export function Activity() {
  const { transactions, isLoading } = useTransactionHistory()

  return (
    <div className="flex min-h-dvh flex-col bg-field px-6 pb-(--spacing-tab-bar) pt-6">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-bold text-on-field">Activity</h1>
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-[var(--color-on-field-muted)]">Loading...</p>
        </div>
      ) : transactions.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-[var(--color-on-field-muted)]">No transactions yet</p>
        </div>
      ) : (
        <div className="-mx-6 flex-1 overflow-y-auto">
          {transactions.map((tx) =>
            tx.layer === 'channel-close' ? (
              <Link
                key={tx.id}
                to={`/activity/close/${tx.channelId}`}
                className="flex items-center gap-4 px-6 py-4 transition-colors hover:bg-on-field/5"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center text-on-field">
                  <ArrowDownLeft className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-on-field">
                    Channel close
                    {CLOSE_BADGES[tx.closeStatus] !== '' && (
                      <span className="ml-2 text-xs font-normal text-[var(--color-on-field-muted)]">
                        {CLOSE_BADGES[tx.closeStatus]}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-[var(--color-on-field-muted)]">
                    {'\u26A1 '}
                    {formatRelativeTime(tx.timestamp)}
                  </div>
                </div>
                <div
                  className={`shrink-0 font-display font-bold ${
                    tx.status === 'pending' ? 'text-[var(--color-on-field-muted)]' : 'text-on-field'
                  }`}
                >
                  {tx.amountSats !== null ? `+${formatBtc(tx.amountSats)}` : '\u2014'}
                </div>
              </Link>
            ) : (
              <Link
                key={tx.id}
                to={`/activity/${tx.id}`}
                state={{ tx }}
                className="flex items-center gap-4 px-6 py-4 transition-colors hover:bg-on-field/5"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center text-on-field">
                  {tx.direction === 'sent' ? (
                    <ArrowUpRight className="h-5 w-5" />
                  ) : (
                    <ArrowDownLeft className="h-5 w-5" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-on-field">
                    {tx.direction === 'sent' ? 'Sent' : 'Received'}
                    {tx.status === 'pending' && (
                      <span className="ml-2 text-xs font-normal text-[var(--color-on-field-muted)]">
                        Pending
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-[var(--color-on-field-muted)]">
                    {tx.layer === 'lightning' && '\u26A1 '}
                    {formatRelativeTime(tx.timestamp)}
                  </div>
                </div>
                <div
                  className={`shrink-0 font-display font-bold ${
                    tx.status === 'pending' ? 'text-[var(--color-on-field-muted)]' : 'text-on-field'
                  }`}
                >
                  {tx.direction === 'sent' ? '-' : '+'}
                  {formatBtc(tx.amountSats)}
                </div>
              </Link>
            )
          )}
        </div>
      )}
    </div>
  )
}
