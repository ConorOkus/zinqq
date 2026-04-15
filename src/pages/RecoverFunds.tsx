import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router'
import { QRCodeSVG } from 'qrcode.react'
import { ChevronBack, CopyIcon, ClockIcon } from '../components/icons'
import { formatBtc } from '../utils/format-btc'
import { useLdk } from '../ldk/use-ldk'
import { useRecovery } from '../ldk/recovery/use-recovery'

export function RecoverFunds() {
  const navigate = useNavigate()
  const ldk = useLdk()
  const vssClient = ldk.status === 'ready' ? ldk.vssClient : null
  const { recovery } = useRecovery(vssClient)
  const [copied, setCopied] = useState(false)

  const copyAddress = useCallback(async () => {
    if (!recovery) return
    try {
      await navigator.clipboard.writeText(recovery.depositAddress)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API can fail (permissions, non-secure context) — silent fallback
    }
  }, [recovery])

  if (!recovery) {
    return (
      <div className="flex flex-1 items-center justify-center bg-dark">
        <p className="text-[var(--color-on-dark-muted)]">No recovery needed</p>
      </div>
    )
  }

  const truncatedAddress =
    recovery.depositAddress.slice(0, 12) + '...' + recovery.depositAddress.slice(-8)

  return (
    <div className="flex flex-1 flex-col bg-dark text-white">
      {/* Header */}
      <header className="relative flex h-14 shrink-0 items-center justify-center px-4">
        <button
          className="absolute left-4 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full transition-colors hover:bg-white/10"
          onClick={() => void navigate('/')}
          aria-label="Back"
        >
          <ChevronBack className="h-6 w-6" />
        </button>
        <span className="text-lg font-semibold">Recover Funds</span>
      </header>

      {/* Content */}
      <div className="flex flex-1 flex-col items-center gap-6 overflow-y-auto px-6 pb-8">
        {/* Explanation */}
        <p className="max-w-xs text-center leading-relaxed text-[var(--color-on-dark-muted)]">
          Your payment channel closed unexpectedly. Your funds are safe — a small deposit is needed
          to move them back to your wallet.
        </p>

        {/* Amounts card */}
        <div className="flex w-full flex-col gap-4 rounded-xl bg-[var(--color-dark-elevated)] px-5 py-4">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">
              Stuck balance
            </span>
            <span className="font-display text-lg font-bold">
              {formatBtc(recovery.stuckBalanceSat)}
            </span>
          </div>
          <hr className="border-[var(--color-dark-border)]" />
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">
              Deposit needed
            </span>
            <span className="font-display text-lg font-bold text-accent">
              {formatBtc(recovery.depositNeededSat)}
            </span>
          </div>
        </div>

        {/* QR Code */}
        <div
          className="flex h-[200px] w-[200px] items-center justify-center rounded-xl bg-white p-4"
          aria-label={`QR code for deposit address ${recovery.depositAddress}`}
        >
          <QRCodeSVG value={`bitcoin:${recovery.depositAddress}`} size={168} />
        </div>

        {/* Address pill */}
        <div className="flex max-w-full items-center gap-3 rounded-full bg-[var(--color-dark-elevated)] px-5 py-3">
          <span className="truncate font-mono text-sm text-[var(--color-on-dark-muted)]">
            {truncatedAddress}
          </span>
          <button
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white transition-transform active:scale-95"
            onClick={() => void copyAddress()}
          >
            {copied ? (
              'Copied!'
            ) : (
              <>
                <CopyIcon className="h-3.5 w-3.5" />
                Copy
              </>
            )}
          </button>
        </div>

        {/* Timelock notice */}
        <div className="flex w-full items-start gap-3 rounded-xl bg-[var(--color-dark-elevated)] p-4">
          <ClockIcon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-on-dark-muted)]" />
          <span className="text-sm leading-snug text-[var(--color-on-dark-muted)]">
            After recovery, funds will be available in approximately 14 days
          </span>
        </div>
      </div>
    </div>
  )
}
