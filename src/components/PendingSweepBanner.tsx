import { useNavigate } from 'react-router'
import type { PendingSweepInfo } from '../ldk/sweep'
import { formatBtc } from '../utils/format-btc'
import { AlertTriangle, ChevronRight } from './icons'

interface PendingSweepBannerProps {
  info: PendingSweepInfo
}

export function PendingSweepBanner({ info }: PendingSweepBannerProps) {
  const navigate = useNavigate()

  const amount = info.pendingSats > 0n ? formatBtc(info.pendingSats) : null
  // pendingSats undercounts when any entry has unknown value — don't present
  // a partial amount as the exact total.
  const heading = amount
    ? `${info.hasUnknownValue ? 'At least ' : ''}${amount} waiting to sweep`
    : 'Funds waiting to sweep'

  if (info.needsOnchainFunds) {
    // The deposit adds its own input weight to the eventual sweep, so the
    // shortfall is a floor — phrase it as "at least".
    const subtext =
      info.shortfallSats !== null && info.shortfallSats > 0n
        ? `Add at least ${formatBtc(info.shortfallSats)} to cover network fees and recover these funds`
        : 'Add bitcoin to cover network fees and recover these funds'
    return (
      <button
        className="flex w-full items-center gap-3 rounded-xl bg-on-field/10 p-4 text-left transition-colors active:bg-on-field/20"
        onClick={() => void navigate('/receive')}
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center text-hot">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-display text-base font-bold">{heading}</div>
          <div className="mt-0.5 text-xs text-[var(--color-on-field-muted)]">{subtext}</div>
        </div>
        <ChevronRight className="h-5 w-5 shrink-0 text-[var(--color-on-field-muted)]" />
      </button>
    )
  }

  return (
    <div className="flex items-center gap-3 rounded-xl bg-on-field/10 p-4">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center">
        <AlertTriangle className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-display text-base font-bold">{heading}</div>
        <div className="mt-0.5 text-xs text-[var(--color-on-field-muted)]">
          Recovered funds return to your balance automatically when network fees allow
        </div>
      </div>
    </div>
  )
}
