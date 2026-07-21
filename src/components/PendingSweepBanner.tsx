import type { PendingSweepInfo } from '../ldk/sweep'
import { formatBtc } from '../utils/format-btc'
import { AlertTriangle } from './icons'

interface PendingSweepBannerProps {
  info: PendingSweepInfo
}

export function PendingSweepBanner({ info }: PendingSweepBannerProps) {
  const amount = info.pendingSats > 0n ? formatBtc(info.pendingSats) : null
  // pendingSats undercounts when any entry has unknown value — don't present
  // a partial amount as the exact total.
  const heading = amount
    ? `${info.hasUnknownValue ? 'At least ' : ''}${amount} waiting to sweep`
    : 'Funds waiting to sweep'

  return (
    <div className="flex items-center gap-3 rounded-xl bg-black/15 p-4">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center">
        <AlertTriangle className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-display text-base font-bold">{heading}</div>
        <div className="mt-0.5 text-xs text-[var(--color-on-accent-muted)]">
          Recovered funds return to your balance automatically when network fees allow
        </div>
      </div>
    </div>
  )
}
