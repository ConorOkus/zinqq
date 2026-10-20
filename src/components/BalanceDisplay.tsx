import { useState, useCallback } from 'react'
import { Link } from 'react-router'
import { formatBtc } from '../utils/format-btc'
import { EyeIcon, EyeOffIcon } from './icons'

interface BalanceDisplayProps {
  dollars: string | null
  bitcoinEquivalent: bigint | null
  recoveryFailed?: boolean
  pending?: bigint
  loading?: boolean
  status: string
  setup?: boolean
}

const STORAGE_KEY = 'balance-visible'

export function BalanceDisplay({
  dollars,
  bitcoinEquivalent,
  recoveryFailed,
  pending,
  loading,
  status,
  setup,
}: BalanceDisplayProps) {
  const [visible, setVisible] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) !== 'false'
    } catch {
      return true
    }
  })

  const toggle = useCallback(() => {
    setVisible((prev) => {
      const next = !prev
      try {
        localStorage.setItem(STORAGE_KEY, String(next))
      } catch {
        // localStorage unavailable
      }
      return next
    })
  }, [])

  if (loading) {
    return (
      <div
        className="flex flex-1 flex-col items-start justify-start pt-[18vh]"
        role="status"
        aria-label="Loading balances"
      >
        <div className="flex h-[clamp(2.5rem,12vw,5rem)] items-center">
          <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-on-field/30 border-t-on-field" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col items-start justify-start pt-[18vh]">
      <div role="group" aria-label="Dollar balance" className="w-full">
        <Link
          to="/settings/stable-balance"
          aria-label="Manage dollar balance"
          className="max-w-full break-all font-display font-bold leading-none tracking-tight text-on-field no-underline"
          style={{ fontSize: 'clamp(2.5rem, 12vw, 5rem)' }}
        >
          {visible ? (dollars ?? '—') : '••••••'}
        </Link>
        {status !== 'Active' && (
          <p className="mt-3 text-sm text-[var(--color-on-field-muted)]" role="status">
            {status}
          </p>
        )}
        {recoveryFailed && (
          <p className="mt-1 text-xs text-[var(--color-on-field-muted)]">
            Could not restore the dollar position. Retrying automatically.
          </p>
        )}
        {setup && (
          <Link
            to="/settings/stable-balance"
            className="mt-1 inline-flex min-h-11 items-center text-sm font-semibold underline underline-offset-4"
          >
            Set up dollars
          </Link>
        )}
      </div>
      <div role="group" aria-label="Bitcoin equivalent" className="mt-3 w-full max-w-sm">
        <p className="mt-1 break-all font-display text-2xl font-semibold text-on-field">
          {visible
            ? bitcoinEquivalent !== null
              ? formatBtc(bitcoinEquivalent)
              : 'Unavailable'
            : '••••••'}
        </p>
        {pending !== undefined && pending > 0n && visible && (
          <p className="mt-1 text-sm text-[var(--color-on-field-muted)]">
            On-chain deposit pending: {formatBtc(pending)}
          </p>
        )}
      </div>
      <button
        className="mt-3 flex items-center gap-2 py-2 text-sm font-medium text-[var(--color-on-field-muted)]"
        onClick={toggle}
        aria-label={visible ? 'Hide balance' : 'Show balance'}
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
        <span>{visible ? 'Hide balance' : 'Show balance'}</span>
      </button>
    </div>
  )
}
