import { useNavigate } from 'react-router'
import { useOnchain } from '../onchain/use-onchain'
import { useLdk } from '../ldk/use-ldk'
import { BalanceDisplay } from '../components/BalanceDisplay'

export function Home() {
  const navigate = useNavigate()
  const onchain = useOnchain()
  const ldk = useLdk()

  const isLoading = onchain.status === 'loading' || ldk.status === 'loading'
  const hasError = onchain.status === 'error' || ldk.status === 'error'

  // Unified balance: on-chain confirmed + trusted pending
  const balance =
    onchain.status === 'ready'
      ? onchain.balance.confirmed + onchain.balance.trustedPending
      : 0n
  const untrustedPending =
    onchain.status === 'ready' ? onchain.balance.untrustedPending : 0n

  if (isLoading) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-accent pb-(--spacing-tab-bar)">
        <p className="text-[var(--color-on-accent-muted)]">
          Loading wallet...
        </p>
      </div>
    )
  }

  if (hasError) {
    const errorMsg =
      onchain.status === 'error'
        ? onchain.error.message
        : ldk.status === 'error'
          ? ldk.error.message
          : 'Unknown error'
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-accent px-6 pb-(--spacing-tab-bar)">
        <p className="text-lg font-semibold text-on-accent">
          Something went wrong
        </p>
        <p className="mt-2 text-sm text-[var(--color-on-accent-muted)]">
          {errorMsg}
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-h-dvh flex-col justify-between bg-accent px-6 pt-4 text-on-accent">
      <BalanceDisplay balance={balance} pending={untrustedPending} />

      <div className="flex gap-3 pb-[calc(var(--spacing-tab-bar)+1rem)]">
        <button
          className="flex h-[88px] flex-1 items-center justify-center gap-3 rounded-2xl bg-on-accent font-display text-xl font-bold uppercase tracking-wide text-white transition-transform active:scale-[0.97]"
          onClick={() => void navigate('/send')}
        >
          Send
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-[22px] w-[22px]"
          >
            <line x1="7" y1="17" x2="17" y2="7" />
            <polyline points="7 7 17 7 17 17" />
          </svg>
        </button>
        <button
          className="flex h-[88px] flex-1 items-center justify-center gap-3 rounded-2xl border-2 border-on-accent font-display text-xl font-bold uppercase tracking-wide text-on-accent transition-transform active:scale-[0.97]"
          onClick={() => void navigate('/receive')}
        >
          Request
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-[22px] w-[22px]"
          >
            <line x1="17" y1="7" x2="7" y2="17" />
            <polyline points="17 17 7 17 7 7" />
          </svg>
        </button>
      </div>
    </div>
  )
}
