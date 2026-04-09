import { Link } from 'react-router'
import { useTransactionHistory } from '../hooks/use-transaction-history'
import { formatBtc } from '../utils/format-btc'
import { ArrowUpRight, ArrowDownLeft } from '../components/icons'

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
    <div className="flex min-h-dvh flex-col bg-accent px-6 pb-(--spacing-tab-bar) pt-6">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-bold text-on-accent">Activity</h1>
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-[var(--color-on-accent-muted)]">Loading...</p>
        </div>
      ) : transactions.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-[var(--color-on-accent-muted)]">No transactions yet</p>
        </div>
      ) : (
        <div className="-mx-6 flex-1 overflow-y-auto">
          {transactions.map((tx) => (
            <Link
              key={tx.id}
              to={`/activity/${tx.id}`}
              state={{ tx }}
              className="flex items-center gap-4 px-6 py-4 transition-colors hover:bg-white/5"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center text-on-accent">
                {tx.direction === 'sent' ? (
                  <ArrowUpRight className="h-5 w-5" />
                ) : (
                  <ArrowDownLeft className="h-5 w-5" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-on-accent">
                  {tx.direction === 'sent' ? 'Sent' : 'Received'}
                  {tx.status === 'pending' && (
                    <span className="ml-2 text-xs font-normal text-[var(--color-on-accent-muted)]">
                      Pending
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-[var(--color-on-accent-muted)]">
                  {tx.layer === 'lightning' && '\u26A1 '}
                  {formatRelativeTime(tx.timestamp)}
                </div>
              </div>
              <div
                className={`shrink-0 font-display font-bold ${
                  tx.status === 'pending' ? 'text-[var(--color-on-accent-muted)]' : 'text-on-accent'
                }`}
              >
                {tx.direction === 'sent' ? '-' : '+'}
                {formatBtc(tx.amountSats)}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
