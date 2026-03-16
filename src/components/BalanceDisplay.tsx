import { useState, useCallback } from 'react'
import { formatBtc } from '../utils/format-btc'
import { EyeIcon, EyeOffIcon } from './icons'

interface BalanceDisplayProps {
  balance: bigint
  pending?: bigint
  breakdown?: string
}

const STORAGE_KEY = 'balance-visible'

export function BalanceDisplay({ balance, pending, breakdown }: BalanceDisplayProps) {
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

  return (
    <div className="flex flex-1 flex-col items-start justify-start pt-[20vh]">
      {visible ? (
        <div
          className="max-w-full break-all font-display font-bold leading-none tracking-tight text-on-accent"
          style={{ fontSize: 'clamp(2.5rem, 12vw, 5rem)' }}
        >
          {formatBtc(balance)}
        </div>
      ) : (
        <div className="font-display text-4xl font-bold tracking-widest text-on-accent">
          &#8226;&#8226;&#8226;&#8226;&#8226;&#8226;
        </div>
      )}
      {pending !== undefined && pending > 0n && visible && (
        <div className="mt-1 text-sm text-[var(--color-on-accent-muted)]">
          +{formatBtc(pending)} pending
        </div>
      )}
      {breakdown && visible && (
        <div className="mt-1 text-sm text-[var(--color-on-accent-muted)]">
          {breakdown}
        </div>
      )}
      <button
        className="mt-3 flex items-center gap-2 py-2 text-sm font-medium text-[var(--color-on-accent-muted)]"
        onClick={toggle}
        aria-label={visible ? 'Hide balance' : 'Show balance'}
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
        <span>{visible ? 'Hide balance' : 'Show balance'}</span>
      </button>
    </div>
  )
}
