import { formatBtc } from '../utils/format-btc'

// TODO: integrate with BDK transaction history
const MOCK_TRANSACTIONS = [
  { type: 'received' as const, label: 'Received', amount: 250000n, time: '2 hours ago' },
  { type: 'sent' as const, label: 'Sent to tb1q...8f3k', amount: 50000n, time: '1 day ago' },
  { type: 'received' as const, label: 'Received', amount: 1000000n, time: '3 days ago' },
  { type: 'sent' as const, label: 'Sent to tb1q...m2px', amount: 125000n, time: '5 days ago' },
  { type: 'received' as const, label: 'Received', amount: 75000n, time: '1 week ago' },
  { type: 'sent' as const, label: 'Sent to tb1q...v9ql', amount: 500000n, time: '2 weeks ago' },
  { type: 'received' as const, label: 'Received', amount: 2500000n, time: '3 weeks ago' },
]

const SendIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
  >
    <line x1="7" y1="17" x2="17" y2="7" />
    <polyline points="7 7 17 7 17 17" />
  </svg>
)

const ReceiveIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
  >
    <line x1="17" y1="7" x2="7" y2="17" />
    <polyline points="17 17 7 17 7 7" />
  </svg>
)

export function Activity() {
  const transactions = MOCK_TRANSACTIONS
  const isEmpty = transactions.length === 0

  return (
    <div className="flex min-h-dvh flex-col bg-accent pb-(--spacing-tab-bar) pt-6">
      <div className="mb-6 px-6">
        <h1 className="font-display text-3xl font-bold text-on-accent">
          Activity
        </h1>
      </div>

      {isEmpty ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-[var(--color-on-accent-muted)]">
            No transactions yet
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {transactions.map((tx, i) => (
            <div
              key={i}
              className="flex items-center gap-4 px-6 py-4"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center text-on-accent">
                {tx.type === 'sent' ? <SendIcon /> : <ReceiveIcon />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-on-accent">{tx.label}</div>
                <div className="mt-0.5 text-xs text-[var(--color-on-accent-muted)]">
                  {tx.time}
                </div>
              </div>
              <div className="shrink-0 font-display font-bold text-on-accent">
                {tx.type === 'sent' ? '-' : '+'}
                {formatBtc(tx.amount)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
