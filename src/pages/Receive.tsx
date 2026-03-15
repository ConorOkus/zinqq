import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router'
import { QRCodeSVG } from 'qrcode.react'
import { useOnchain } from '../onchain/use-onchain'
import { ScreenHeader } from '../components/ScreenHeader'

export function Receive() {
  const navigate = useNavigate()
  const onchain = useOnchain()
  const [address, setAddress] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)
  const generateAddress = onchain.status === 'ready' ? onchain.generateAddress : null

  useEffect(() => {
    if (generateAddress && address === null) {
      setAddress(generateAddress())
    }
  }, [generateAddress, address])

  // Focus trap: keep focus within overlay
  useEffect(() => {
    const el = overlayRef.current
    if (!el) return
    const getFocusable = () =>
      el.querySelectorAll<HTMLElement>('button, a, input, [tabindex]')
    const focusable = getFocusable()
    if (focusable.length > 0) focusable[0].focus()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const items = getFocusable()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    el.addEventListener('keydown', handleKeyDown)
    return () => el.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleCopy = useCallback(async () => {
    if (!address) return
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
    } catch {
      // Address is displayed and selectable as fallback
    }
  }, [address])

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(id)
  }, [copied])

  const handleClose = useCallback(() => {
    void navigate('/')
  }, [navigate])

  if (onchain.status === 'loading') {
    return (
      <div className="fixed inset-0 z-200 mx-auto flex max-w-[430px] flex-col items-center justify-center bg-dark">
        <p className="text-[var(--color-on-dark-muted)]">Loading wallet...</p>
      </div>
    )
  }

  if (onchain.status === 'error') {
    return (
      <div className="fixed inset-0 z-200 mx-auto flex max-w-[430px] flex-col items-center justify-center bg-dark px-6">
        <p className="text-lg font-semibold text-on-dark">Failed to load wallet</p>
        <p className="mt-2 text-sm text-red-400">{onchain.error.message}</p>
        <button
          className="mt-6 text-sm text-accent"
          onClick={handleClose}
        >
          Close
        </button>
      </div>
    )
  }

  const qrValue = address ? `BITCOIN:${address.toUpperCase()}` : ''
  const truncated = address
    ? `${address.slice(0, 12)}...${address.slice(-8)}`
    : ''

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-200 mx-auto flex max-w-[430px] flex-col items-center bg-dark text-on-dark"
    >
      <ScreenHeader title="Request" onClose={handleClose} />

      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-8">
        {address && (
          <>
            <div
              className="flex h-[260px] w-[260px] items-center justify-center rounded-2xl bg-white p-5"
              aria-label={`QR code for Bitcoin address ${address}`}
            >
              <QRCodeSVG value={qrValue} size={220} />
            </div>

            <p className="max-w-[280px] text-center font-display text-2xl font-bold leading-snug">
              Request money by letting someone scan this
            </p>

            <div className="flex max-w-full items-center gap-3 rounded-full bg-dark-elevated px-5 py-3">
              <span className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-sm text-[var(--color-on-dark-muted)]">
                {truncated}
              </span>
              <button
                className="shrink-0 rounded-full bg-accent px-4 py-2 text-xs font-bold uppercase tracking-wider text-white transition-transform active:scale-95"
                onClick={() => void handleCopy()}
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
