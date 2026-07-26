import { useNavigate } from 'react-router'
import type { RecoveryState } from '../ldk/recovery/recovery-state'
import { AlertTriangle, Check, ChevronRight, XClose } from './icons'

interface RecoveryBannerProps {
  recovery: RecoveryState
  onDismiss: () => void
}

export function RecoveryBanner({ recovery, onDismiss }: RecoveryBannerProps) {
  const navigate = useNavigate()

  if (recovery.status === 'sweep_confirmed') {
    return (
      <div className="flex items-center gap-3 rounded-xl bg-on-field/10 p-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center">
          <Check className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-display text-base font-bold">Funds recovered!</div>
          <div className="mt-0.5 text-xs text-[var(--color-on-field-muted)]">
            Available in approximately 14 days
          </div>
        </div>
        <button
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors active:bg-on-field/15"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <XClose className="h-4 w-4 text-[var(--color-on-field-muted)]" />
        </button>
      </div>
    )
  }

  return (
    <button
      className="flex w-full items-center gap-3 rounded-xl bg-on-field/10 p-4 text-left transition-colors active:bg-on-field/20"
      onClick={() => void navigate('/recover')}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center text-hot">
        <AlertTriangle className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-display text-base font-bold">Your funds are safe</div>
        <div className="mt-0.5 text-xs text-[var(--color-on-field-muted)]">
          A small deposit is needed to unlock them
        </div>
      </div>
      <ChevronRight className="h-5 w-5 shrink-0 text-[var(--color-on-field-muted)]" />
    </button>
  )
}
