import { useUnifiedBalance } from '../hooks/use-unified-balance'
import { formatBtc } from '../utils/format-btc'
import { ScreenHeader } from '../components/ScreenHeader'

export function Balance() {
  const { total, onchain, lightning, pending, isLoading } = useUnifiedBalance()

  if (isLoading) {
    return (
      <div className="flex min-h-dvh flex-col bg-dark text-on-dark">
        <ScreenHeader title="Balance" backTo="/settings/advanced" />
        <div className="flex flex-1 items-center justify-center">
          <p className="text-[var(--color-on-dark-muted)]">Loading...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-dvh flex-col bg-dark text-on-dark">
      <ScreenHeader title="Balance" backTo="/settings/advanced" />
      <div className="flex flex-col gap-4 px-6 pt-4">
        {/* Total */}
        <div className="rounded-xl bg-dark-elevated p-4">
          <span className="text-sm text-[var(--color-on-dark-muted)]">Total</span>
          <div className="mt-1 font-display text-3xl font-bold">{formatBtc(total)}</div>
          {pending > 0n && (
            <div className="mt-1 text-sm text-[var(--color-on-dark-muted)]">
              +{formatBtc(pending)} pending
            </div>
          )}
        </div>

        {/* Breakdown */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between rounded-xl bg-dark-elevated p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-orange-500/20">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 text-orange-400">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v12M9 9h4.5a2.5 2.5 0 0 1 0 5H9" />
                </svg>
              </div>
              <span className="font-semibold">On-chain</span>
            </div>
            <span className="font-display text-lg font-bold">{formatBtc(onchain)}</span>
          </div>

          <div className="flex items-center justify-between rounded-xl bg-dark-elevated p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-yellow-500/20">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 text-yellow-400">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
              </div>
              <span className="font-semibold">Lightning</span>
            </div>
            <span className="font-display text-lg font-bold">{formatBtc(lightning)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
