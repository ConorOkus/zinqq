import { useNavigate } from 'react-router'
import { useOnchain } from '../onchain/use-onchain'
import { useLdk } from '../ldk/use-ldk'
import { useUnifiedBalance } from '../hooks/use-unified-balance'
import { BalanceDisplay } from '../components/BalanceDisplay'
import { formatBtc } from '../utils/format-btc'
import { ArrowUpRight, ArrowDownLeft } from '../components/icons'

export function Home() {
  const navigate = useNavigate()
  const onchain = useOnchain()
  const ldk = useLdk()
  const { total, onchain: onchainBal, lightning, pending, isLoading } = useUnifiedBalance()

  const hasError = onchain.status === 'error' || ldk.status === 'error'

  const breakdown =
    onchainBal > 0n && lightning > 0n
      ? `${formatBtc(onchainBal)} onchain · ${formatBtc(lightning)} lightning`
      : undefined

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
      <BalanceDisplay balance={total} pending={pending} breakdown={breakdown} />

      <div className="flex gap-3 pb-[calc(var(--spacing-tab-bar)+1rem)]">
        <button
          className="flex h-[88px] flex-1 items-center justify-center gap-3 rounded-2xl bg-on-accent font-display text-xl font-bold uppercase tracking-wide text-white transition-transform active:scale-[0.97]"
          onClick={() => void navigate('/send')}
        >
          Send
          <ArrowUpRight className="h-[22px] w-[22px]" />
        </button>
        <button
          className="flex h-[88px] flex-1 items-center justify-center gap-3 rounded-2xl border-2 border-on-accent font-display text-xl font-bold uppercase tracking-wide text-on-accent transition-transform active:scale-[0.97]"
          onClick={() => void navigate('/receive')}
        >
          Request
          <ArrowDownLeft className="h-[22px] w-[22px]" />
        </button>
      </div>
    </div>
  )
}
