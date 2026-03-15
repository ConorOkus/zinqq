import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router'
import { QRCodeSVG } from 'qrcode.react'
import { useOnchain } from '../onchain/use-onchain'

export function Receive() {
  const onchain = useOnchain()
  const [address, setAddress] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const generateAddress = onchain.status === 'ready' ? onchain.generateAddress : null

  useEffect(() => {
    if (generateAddress && address === null) {
      setAddress(generateAddress())
    }
  }, [generateAddress, address])

  const handleCopy = useCallback(async () => {
    if (!address) return
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setCopyError(false)
    } catch {
      setCopyError(true)
    }
  }, [address])

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(id)
  }, [copied])

  useEffect(() => {
    if (!copyError) return
    const id = setTimeout(() => setCopyError(false), 3000)
    return () => clearTimeout(id)
  }, [copyError])

  if (onchain.status === 'loading') {
    return <p className="text-center text-gray-500">Loading wallet...</p>
  }

  if (onchain.status === 'error') {
    return (
      <div className="space-y-2">
        <p className="text-red-600 font-medium">Failed to load wallet</p>
        <p className="text-sm text-red-500">{onchain.error.message}</p>
        <Link to="/" className="text-sm text-blue-600 hover:underline">
          Back to Home
        </Link>
      </div>
    )
  }

  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const overlay = overlayRef.current
    if (!overlay) return

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return

      const focusable = overlay!.querySelectorAll<HTMLElement>(
        'button, a, input, [tabindex]'
      )
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    overlay.addEventListener('keydown', handleKeyDown)
    // Focus first focusable element on mount
    const firstFocusable = overlay.querySelector<HTMLElement>(
      'button, a, input, [tabindex]'
    )
    firstFocusable?.focus()

    return () => overlay.removeEventListener('keydown', handleKeyDown)
  }, [address])

  const { balance } = onchain
  const pending = balance.trustedPending + balance.untrustedPending
  const qrValue = address ? `BITCOIN:${address.toUpperCase()}` : ''

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Receive Bitcoin</h1>

      {address && (
        <div ref={overlayRef} className="flex flex-col items-center space-y-4">
          <div
            aria-label={`QR code for Bitcoin address ${address}`}
            className="rounded-lg bg-white p-4"
          >
            <QRCodeSVG value={qrValue} size={200} />
          </div>

          <p className="max-w-sm text-center font-mono text-sm break-all text-gray-700 dark:text-gray-300">
            {address}
          </p>

          <button
            onClick={() => void handleCopy()}
            className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700"
          >
            {copied ? 'Copied!' : 'Copy Address'}
          </button>

          {copyError && (
            <p className="text-sm text-red-600">
              Copy failed — select and copy manually
            </p>
          )}
        </div>
      )}

      <div className="space-y-1">
        <p className="text-lg font-semibold">
          {balance.confirmed.toString()} sats
        </p>
        {pending > 0n && (
          <p className="text-sm text-gray-500">
            +{pending.toString()} sats pending
          </p>
        )}
      </div>
    </div>
  )
}
