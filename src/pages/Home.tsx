import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useOnchain } from '../onchain/use-onchain'
import { useLdk } from '../ldk/use-ldk'
import { useUnifiedBalance } from '../hooks/use-unified-balance'
import { usePwaInstall } from '../hooks/use-pwa-install'
import { useRecovery } from '../ldk/recovery/use-recovery'
import { usePendingSweep } from '../ldk/use-pending-sweep'
import { BalanceDisplay } from '../components/BalanceDisplay'
import { RecoveryBanner } from '../components/RecoveryBanner'
import { PendingSweepBanner } from '../components/PendingSweepBanner'
import { ArrowUpRight, ArrowDownLeft, RefreshIcon, HomeIcon } from '../components/icons'

export function Home() {
  const navigate = useNavigate()
  const onchain = useOnchain()
  const ldk = useLdk()
  const { total, pending, isLoading } = useUnifiedBalance()
  const { canInstall, isIos, isStandalone, promptInstall } = usePwaInstall()
  const vssClient = ldk.status === 'ready' ? ldk.vssClient : null
  const { recovery, dismiss: dismissRecovery } = useRecovery(vssClient)
  const pendingSweep = usePendingSweep()
  const [showIosHint, setShowIosHint] = useState(false)

  const showInstallButton = !isStandalone && (canInstall || isIos)

  const hasError = onchain.status === 'error' || ldk.status === 'error'

  if (hasError) {
    const errorMsg =
      onchain.status === 'error'
        ? onchain.error.message
        : ldk.status === 'error'
          ? ldk.error.message
          : 'Unknown error'
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-field px-6 pb-(--spacing-tab-bar)">
        <p className="text-lg font-semibold text-on-field">Something went wrong</p>
        <p className="mt-2 text-sm text-[var(--color-on-field-muted)]">{errorMsg}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col justify-between bg-field px-6 pt-4 text-on-field">
      <div className="-mx-4 flex justify-between pt-[env(safe-area-inset-top,0px)]">
        {showInstallButton ? (
          <button
            className="flex h-11 w-11 items-center justify-center rounded-full text-on-field transition-colors active:bg-on-field/10"
            onClick={() => (isIos ? setShowIosHint(true) : promptInstall())}
            aria-label="Install app"
          >
            <HomeIcon className="h-5 w-5" />
          </button>
        ) : (
          <div className="h-11 w-11" />
        )}
        <button
          className="flex h-11 w-11 items-center justify-center rounded-full text-on-field transition-colors active:bg-on-field/10"
          onClick={() => window.location.reload()}
          aria-label="Refresh"
        >
          <RefreshIcon className="h-5 w-5" />
        </button>
      </div>

      {showIosHint && (
        <div className="mx-auto max-w-xs rounded-xl bg-on-field/10 p-4 text-center text-sm text-on-field backdrop-blur-sm">
          <p className="font-semibold">Add to Home Screen</p>
          <p className="mt-1 text-[var(--color-on-field-muted)]">
            Tap the share button in Safari, then select &ldquo;Add to Home Screen&rdquo;
          </p>
          <button className="mt-3 text-xs underline" onClick={() => setShowIosHint(false)}>
            Dismiss
          </button>
        </div>
      )}
      <BalanceDisplay balance={total} pending={pending} loading={isLoading} />

      {recovery && (
        <div className="mb-3">
          <RecoveryBanner recovery={recovery} onDismiss={() => void dismissRecovery()} />
        </div>
      )}

      {pendingSweep?.lastAttemptFailed && (
        <div className="mb-3">
          <PendingSweepBanner info={pendingSweep} />
        </div>
      )}

      <div className="flex gap-3 pb-[calc(var(--spacing-tab-bar)+0.75rem+env(safe-area-inset-bottom,0px))]">
        <button
          className="flex h-[88px] flex-1 items-center justify-center gap-3 rounded-2xl bg-field-cta font-display text-xl font-bold uppercase tracking-wide text-on-field-cta transition-transform active:scale-[0.97]"
          onClick={() => void navigate('/send')}
        >
          Send
          <ArrowUpRight className="h-[22px] w-[22px]" />
        </button>
        <button
          className="flex h-[88px] flex-1 items-center justify-center gap-3 rounded-2xl border-2 border-[var(--color-field-outline)] font-display text-xl font-bold uppercase tracking-wide text-on-field transition-transform active:scale-[0.97]"
          onClick={() => void navigate('/receive')}
        >
          Request
          <ArrowDownLeft className="h-[22px] w-[22px]" />
        </button>
      </div>
    </div>
  )
}
