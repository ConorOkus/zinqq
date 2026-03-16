import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router'
import { QRCodeSVG } from 'qrcode.react'
import { useOnchain } from '../onchain/use-onchain'
import { useLdk } from '../ldk/use-ldk'
import { ScreenHeader } from '../components/ScreenHeader'

export function Receive() {
  const navigate = useNavigate()
  const onchain = useOnchain()
  const ldk = useLdk()
  const [address, setAddress] = useState<string | null>(null)
  const [invoice, setInvoice] = useState<string | null>(null)
  const [addressError, setAddressError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)
  const generateAddress = onchain.status === 'ready' ? onchain.generateAddress : null
  const createInvoice = ldk.status === 'ready' ? ldk.createInvoice : null

  useEffect(() => {
    if (generateAddress && address === null && addressError === null) {
      try {
        setAddress(generateAddress())
      } catch (err) {
        console.error('[Receive] Failed to generate address:', err)
        setAddressError(err instanceof Error ? err.message : 'Failed to generate address')
      }
    }
  }, [generateAddress, address, addressError])

  useEffect(() => {
    if (createInvoice && invoice === null) {
      try {
        setInvoice(createInvoice())
      } catch (err) {
        // Lightning invoice is optional — onchain fallback still works
        console.warn('[Receive] Failed to create invoice:', err)
      }
    }
  }, [createInvoice, invoice])

  // Focus trap: keep focus within overlay
  useEffect(() => {
    const el = overlayRef.current
    if (!el) return
    const getFocusable = () =>
      el.querySelectorAll<HTMLElement>('button, a, input, [tabindex]')
    const focusable = getFocusable()
    if (focusable.length > 0) focusable[0]?.focus()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const items = getFocusable()
      if (items.length === 0) return
      const first = items[0] as HTMLElement | undefined
      const last = items[items.length - 1] as HTMLElement | undefined
      if (e.shiftKey && first && document.activeElement === first) {
        e.preventDefault()
        last?.focus()
      } else if (!e.shiftKey && last && document.activeElement === last) {
        e.preventDefault()
        first?.focus()
      }
    }
    el.addEventListener('keydown', handleKeyDown)
    return () => el.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Build BIP 321 URI: bitcoin:<ADDRESS>?lightning=<BOLT11>
  const bip321Uri = address
    ? invoice
      ? `bitcoin:${address.toUpperCase()}?lightning=${invoice}`
      : `bitcoin:${address.toUpperCase()}`
    : ''

  const handleCopy = useCallback(async () => {
    if (!bip321Uri) return
    try {
      await navigator.clipboard.writeText(bip321Uri)
      setCopied(true)
    } catch {
      // Address is displayed and selectable as fallback
    }
  }, [bip321Uri])

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(id)
  }, [copied])

  if (onchain.status === 'loading' || ldk.status === 'loading') {
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
          onClick={() => void navigate('/')}
        >
          Close
        </button>
      </div>
    )
  }

  // QR uses uppercase for optimal alphanumeric QR encoding
  const qrValue = bip321Uri.toUpperCase()
  const truncated = address
    ? `bitcoin:${address.slice(0, 8)}...${address.slice(-6)}`
    : ''

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-200 mx-auto flex max-w-[430px] flex-col bg-dark text-on-dark"
    >
      <ScreenHeader title="Request" backTo="/" />

      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-8">
        {addressError && (
          <p className="text-sm text-red-400">{addressError}</p>
        )}
        {address && (
          <>
            <div
              className="flex h-[260px] w-[260px] items-center justify-center rounded-2xl bg-white p-5"
              aria-label={`QR code for Bitcoin address ${address}`}
            >
              <QRCodeSVG value={qrValue} size={220} />
            </div>

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
