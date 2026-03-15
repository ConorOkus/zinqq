import { useState, useCallback, useRef } from 'react'
import { Link } from 'react-router'
import { useOnchain } from '../onchain/use-onchain'
import { parseBip21 } from '../onchain/bip21'
import { ONCHAIN_CONFIG } from '../onchain/config'

type SendStep =
  | { step: 'input' }
  | {
      step: 'reviewing'
      address: string
      amount: bigint
      fee: bigint
      feeRate: bigint
      isSendMax: boolean
    }
  | { step: 'broadcasting' }
  | { step: 'success'; txid: string }
  | { step: 'error'; message: string }

const MIN_DUST_SATS = 294n

function classifyEstimateError(err: unknown): { field: 'address' | 'amount'; message: string } {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('network') || msg.includes('different Bitcoin network')) {
    return { field: 'address', message: 'This address is for a different Bitcoin network' }
  }
  if (msg.includes('Invalid') || msg.includes('address')) {
    return { field: 'address', message: 'Invalid Bitcoin address' }
  }
  return { field: 'amount', message: msg }
}

export function Send() {
  const onchain = useOnchain()
  const [sendStep, setSendStep] = useState<SendStep>({ step: 'input' })
  const [address, setAddress] = useState('')
  const [amountStr, setAmountStr] = useState('')
  const [isSendMax, setIsSendMax] = useState(false)
  const [addressError, setAddressError] = useState<string | null>(null)
  const [amountError, setAmountError] = useState<string | null>(null)
  const sendingRef = useRef(false)

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLInputElement>) => {
      const pasted = e.clipboardData.getData('text')
      const bip21 = parseBip21(pasted)
      if (bip21) {
        e.preventDefault()
        setAddress(bip21.address)
        if (bip21.amountSats !== undefined && !isSendMax) {
          setAmountStr(bip21.amountSats.toString())
        }
        setAddressError(null)
      }
    },
    [isSendMax],
  )

  const handleSendMaxToggle = useCallback(() => {
    setIsSendMax((prev) => {
      if (!prev) setAmountStr('')
      return !prev
    })
    setAmountError(null)
  }, [])

  const validateAndReview = useCallback(async () => {
    if (onchain.status !== 'ready') return

    setAddressError(null)
    setAmountError(null)

    const trimmedAddress = address.trim()
    if (!trimmedAddress) {
      setAddressError('Enter a Bitcoin address')
      return
    }

    if (isSendMax) {
      try {
        const estimate = await onchain.estimateMaxSendable(trimmedAddress)
        if (estimate.amount <= 0n) {
          setAmountError('Balance too low to cover fees')
          return
        }
        setSendStep({
          step: 'reviewing',
          address: trimmedAddress,
          amount: estimate.amount,
          fee: estimate.fee,
          feeRate: estimate.feeRate,
          isSendMax: true,
        })
      } catch (err) {
        const { field, message } = classifyEstimateError(err)
        if (field === 'address') setAddressError(message)
        else setAmountError(message)
      }
      return
    }

    const amountSats = (() => {
      try {
        return BigInt(amountStr)
      } catch {
        return null
      }
    })()

    if (amountSats === null || amountSats <= 0n) {
      setAmountError('Enter an amount')
      return
    }

    if (amountSats < MIN_DUST_SATS) {
      setAmountError('Amount must be at least 294 sats')
      return
    }

    if (amountSats > onchain.balance.confirmed + onchain.balance.trustedPending) {
      setAmountError('Amount exceeds available balance')
      return
    }

    try {
      const estimate = await onchain.estimateFee(trimmedAddress, amountSats)
      setSendStep({
        step: 'reviewing',
        address: trimmedAddress,
        amount: amountSats,
        fee: estimate.fee,
        feeRate: estimate.feeRate,
        isSendMax: false,
      })
    } catch (err) {
      const { field, message } = classifyEstimateError(err)
      if (field === 'address') setAddressError(message)
      else setAmountError(message)
    }
  }, [onchain, address, amountStr, isSendMax])

  const handleConfirm = useCallback(async () => {
    if (sendingRef.current) return
    if (onchain.status !== 'ready' || sendStep.step !== 'reviewing') return

    sendingRef.current = true
    setSendStep({ step: 'broadcasting' })

    try {
      const txid = sendStep.isSendMax
        ? await onchain.sendMax(sendStep.address, sendStep.feeRate)
        : await onchain.sendToAddress(sendStep.address, sendStep.amount, sendStep.feeRate)
      setSendStep({ step: 'success', txid })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSendStep({ step: 'error', message })
    } finally {
      sendingRef.current = false
    }
  }, [onchain, sendStep])

  const handleBack = useCallback(() => {
    setSendStep({ step: 'input' })
  }, [])


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
  const explorerBaseUrl = ONCHAIN_CONFIG.explorerUrl

  // Success screen
  if (sendStep.step === 'success') {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Transaction Sent</h1>
        <p className="text-green-600 font-medium">Your transaction has been broadcast.</p>
        <div className="space-y-2">
          <p className="text-sm text-gray-500">Transaction ID</p>
          <a
            href={`${explorerBaseUrl}/tx/${sendStep.txid}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block font-mono text-sm text-blue-600 hover:underline break-all"
          >
            {sendStep.txid}
          </a>
        </div>
        <Link
          to="/"
          className="inline-block px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700"
        >
          Back to Home
        </Link>
      </div>
    )
  }

  // Error screen
  if (sendStep.step === 'error') {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Send Failed</h1>
        <p className="text-red-600 font-medium">{sendStep.message}</p>
        <p className="text-sm text-gray-500">Your funds are safe.</p>
        <button
          onClick={handleBack}
          className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700"
        >
          Try Again
        </button>
      </div>
    )
  }

  // Broadcasting screen
  if (sendStep.step === 'broadcasting') {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Sending...</h1>
        <p className="text-gray-500">Building, signing, and broadcasting your transaction.</p>
      </div>
    )
  }

  // Review screen
  if (sendStep.step === 'reviewing') {
    const total = sendStep.amount + sendStep.fee
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Review Transaction</h1>

        <div className="space-y-4">
          <div className="space-y-1">
            <p className="text-sm text-gray-500">To</p>
            <p className="font-mono text-sm break-all">{sendStep.address}</p>
          </div>

          <div className="space-y-1">
            <p className="text-sm text-gray-500">Amount</p>
            <p className="text-lg font-semibold">{sendStep.amount.toString()} sats</p>
          </div>

          <div className="space-y-1">
            <p className="text-sm text-gray-500">
              Fee ({sendStep.feeRate.toString()} sat/vB)
            </p>
            <p className="text-sm">{sendStep.fee.toString()} sats</p>
          </div>

          <div className="border-t border-gray-200 dark:border-gray-700 pt-2">
            <p className="text-sm text-gray-500">Total</p>
            <p className="text-lg font-bold">{total.toString()} sats</p>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleBack}
            className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            Back
          </button>
          <button
            onClick={() => void handleConfirm()}
            className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700"
          >
            Confirm Send
          </button>
        </div>
      </div>
    )
  }

  // Input screen
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Send Bitcoin</h1>

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

      <div className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="address" className="text-sm font-medium">
            Recipient Address
          </label>
          <input
            id="address"
            type="text"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value)
              setAddressError(null)
            }}
            onPaste={handlePaste}
            placeholder="tb1q... or bitcoin:tb1q..."
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-800"
          />
          {addressError && (
            <p className="text-sm text-red-500">{addressError}</p>
          )}
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label htmlFor="amount" className="text-sm font-medium">
              Amount (sats)
            </label>
            <button
              onClick={handleSendMaxToggle}
              className={`text-xs px-2 py-1 rounded ${
                isSendMax
                  ? 'bg-blue-600 text-white'
                  : 'border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              Send Max
            </button>
          </div>
          <input
            id="amount"
            type="number"
            step="1"
            min="1"
            value={isSendMax ? '' : amountStr}
            onChange={(e) => {
              setAmountStr(e.target.value)
              setAmountError(null)
            }}
            disabled={isSendMax}
            placeholder={isSendMax ? 'Sending entire balance' : 'Amount in sats'}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
          />
          {amountError && (
            <p className="text-sm text-red-500">{amountError}</p>
          )}
        </div>
      </div>

      <button
        onClick={() => void validateAndReview()}
        disabled={!address.trim()}
        className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Review Transaction
      </button>
    </div>
  )
}
