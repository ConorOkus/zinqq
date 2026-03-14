import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router'
import { QRCodeSVG } from 'qrcode.react'
import { useOnchain } from '../onchain/use-onchain'

export function Receive() {
  const onchain = useOnchain()
  const [address, setAddress] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
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
    } catch {
      // Address is already displayed and selectable as fallback
    }
  }, [address])

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(id)
  }, [copied])

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

  const { balance } = onchain
  const pending = balance.trustedPending + balance.untrustedPending
  const qrValue = address ? `BITCOIN:${address.toUpperCase()}` : ''

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Receive Bitcoin</h1>

      {address && (
        <div className="flex flex-col items-center space-y-4">
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
