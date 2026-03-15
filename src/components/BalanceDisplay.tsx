import { useState, useCallback } from 'react'
import { formatBtc } from '../utils/format-btc'

interface BalanceDisplayProps {
  balance: bigint
  pending?: bigint
}

const STORAGE_KEY = 'balance-visible'

const EyeSvg = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
  >
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

const EyeOffSvg = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
  >
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
)

export function BalanceDisplay({ balance, pending }: BalanceDisplayProps) {
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
      <button
        className="mt-3 flex items-center gap-2 py-2 text-sm font-medium text-[var(--color-on-accent-muted)]"
        onClick={toggle}
        aria-label={visible ? 'Hide balance' : 'Show balance'}
      >
        {visible ? <EyeOffSvg /> : <EyeSvg />}
        <span>{visible ? 'Hide balance' : 'Show balance'}</span>
      </button>
    </div>
  )
}
