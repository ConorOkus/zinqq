import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router'
import { ScreenHeader } from '../components/ScreenHeader'
import { MnemonicWordGrid } from '../components/MnemonicWordGrid'
import { getMnemonic } from '../wallet/mnemonic'
import { captureError } from '../storage/error-log'

const AUTO_HIDE_MS = 60_000

type BackupState =
  | { status: 'warning' }
  | { status: 'revealed'; words: string[] }
  | { status: 'error'; message: string }

export function Backup() {
  const [state, setState] = useState<BackupState>({ status: 'warning' })
  const [countdown, setCountdown] = useState(AUTO_HIDE_MS / 1000)
  const navigate = useNavigate()

  const hideWords = useCallback(() => {
    setState({ status: 'warning' })
    setCountdown(AUTO_HIDE_MS / 1000)
  }, [])

  const handleReveal = async () => {
    try {
      const mnemonic = await getMnemonic()
      if (!mnemonic) {
        setState({
          status: 'error',
          message: 'Unable to retrieve seed phrase. Your wallet storage may be corrupted.',
        })
        return
      }
      setState({ status: 'revealed', words: mnemonic.split(' ') })
      setCountdown(AUTO_HIDE_MS / 1000)
    } catch (err) {
      captureError('error', 'Backup', 'Failed to retrieve mnemonic', String(err))
      setState({
        status: 'error',
        message: 'Unable to retrieve seed phrase. Please restart the app and try again.',
      })
    }
  }

  // Auto-hide after 60s + clear on tab hidden
  useEffect(() => {
    if (state.status !== 'revealed') return

    const timer = setTimeout(hideWords, AUTO_HIDE_MS)
    const interval = setInterval(() => {
      setCountdown((prev) => Math.max(0, prev - 1))
    }, 1000)

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') hideWords()
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      clearTimeout(timer)
      clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [state.status, hideWords])

  return (
    <div className="flex min-h-dvh flex-col bg-dark text-on-dark">
      <ScreenHeader title="Wallet Backup" backTo="/settings" />

      <div className="flex flex-1 flex-col px-4 pb-8">
        {state.status === 'warning' && (
          <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-dark-elevated">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-8 w-8 text-amber-400"
              >
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </div>
            <div className="space-y-3">
              <h2 className="font-display text-xl font-bold">
                Your recovery phrase is the master key to your wallet.
              </h2>
              <p className="text-sm text-[var(--color-on-dark-muted)]">
                Anyone who has these 12 words can access and steal your funds. Never share them with
                anyone.
              </p>
            </div>
            <ul className="space-y-2 text-left text-sm text-[var(--color-on-dark-muted)]">
              <li className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0">&#x2022;</span>
                Write them down on paper and store securely
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0">&#x2022;</span>
                Do not take a screenshot
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0">&#x2022;</span>
                Do not copy to clipboard or save digitally
              </li>
            </ul>
            <button
              onClick={() => void handleReveal()}
              className="mt-4 w-full rounded-xl bg-accent px-6 py-4 font-display font-bold text-white active:scale-[0.98]"
            >
              Reveal Seed Phrase
            </button>
          </div>
        )}

        {state.status === 'revealed' && (
          <div className="flex flex-1 flex-col gap-6 pt-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-[var(--color-on-dark-muted)]">
                Write down these 12 words in order.
              </p>
              <span className="text-xs text-[var(--color-on-dark-muted)]">
                Hides in {countdown}s
              </span>
            </div>
            <MnemonicWordGrid words={state.words} />
            {import.meta.env.DEV && (
              <button
                onClick={() => void navigator.clipboard.writeText(state.words.join(' '))}
                className="w-full rounded-xl border border-amber-500/30 bg-amber-500/10 px-6 py-3 text-sm font-semibold text-amber-400 active:scale-[0.98]"
              >
                Copy to Clipboard (dev only)
              </button>
            )}
            <button
              onClick={() => void navigate('/settings')}
              className="mt-4 w-full rounded-xl bg-dark-elevated px-6 py-4 font-display font-bold text-white active:scale-[0.98]"
            >
              Done
            </button>
          </div>
        )}

        {state.status === 'error' && (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <p className="text-sm text-red-400">{state.message}</p>
          </div>
        )}
      </div>
    </div>
  )
}
