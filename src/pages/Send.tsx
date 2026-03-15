import { useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router'
import { useOnchain } from '../onchain/use-onchain'
import { parseBip21 } from '../onchain/bip21'
import { ONCHAIN_CONFIG } from '../onchain/config'
import { formatBtc } from '../utils/format-btc'
import { ScreenHeader } from '../components/ScreenHeader'
import { Numpad, type NumpadKey } from '../components/Numpad'

type SendStep =
  | { step: 'address' }
  | { step: 'amount' }
  | {
      step: 'reviewing'
      address: string
      amount: bigint
      fee: bigint
      feeRate: bigint
      isSendMax: boolean
    }
  | { step: 'broadcasting' }
  | { step: 'success'; txid: string; amount: bigint }
  | { step: 'error'; message: string }

const MIN_DUST_SATS = 294n
const TXID_RE = /^[0-9a-f]{64}$/i
const MAX_DIGITS = 8

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
  const navigate = useNavigate()
  const onchain = useOnchain()
  const [sendStep, setSendStep] = useState<SendStep>({ step: 'address' })
  const [address, setAddress] = useState('')
  const [amountDigits, setAmountDigits] = useState('')
  const [addressError, setAddressError] = useState<string | null>(null)
  const [amountError, setAmountError] = useState<string | null>(null)
  const sendingRef = useRef(false)

  const balance =
    onchain.status === 'ready'
      ? onchain.balance.confirmed + onchain.balance.trustedPending
      : 0n

  // --- Numpad handlers ---
  const handleNumpadKey = useCallback((key: NumpadKey) => {
    setAmountError(null)
    setAmountDigits((prev) => {
      if (key === 'backspace') return prev.slice(0, -1)
      if (prev.length >= MAX_DIGITS) return prev
      if (prev === '0' && key === '0') return prev
      if (prev === '' && key === '0') return '0'
      if (prev === '0') return key
      return prev + key
    })
  }, [])

  const amountSats = amountDigits ? BigInt(amountDigits) : 0n

  // --- Address step ---
  const handleAddressPaste = useCallback(
    (e: React.ClipboardEvent<HTMLInputElement>) => {
      const pasted = e.clipboardData.getData('text')
      const bip21 = parseBip21(pasted)
      if (bip21) {
        e.preventDefault()
        setAddress(bip21.address)
        if (bip21.amountSats !== undefined) {
          setAmountDigits(bip21.amountSats.toString())
        }
        setAddressError(null)
      }
    },
    [],
  )

  const handleAddressNext = useCallback(() => {
    if (!address.trim()) {
      setAddressError('Enter a Bitcoin address')
      return
    }
    setAddressError(null)
    setSendStep({ step: 'amount' })
  }, [address])

  // --- Send max ---
  const handleSendMax = useCallback(async () => {
    if (onchain.status !== 'ready') return
    setAmountError(null)
    try {
      const estimate = await onchain.estimateMaxSendable(address.trim())
      if (estimate.amount <= 0n) {
        setAmountError('Balance too low to cover fees')
        return
      }
      setSendStep({
        step: 'reviewing',
        address: address.trim(),
        amount: estimate.amount,
        fee: estimate.fee,
        feeRate: estimate.feeRate,
        isSendMax: true,
      })
    } catch (err) {
      const { field, message } = classifyEstimateError(err)
      if (field === 'address') {
        setAddressError(message)
        setSendStep({ step: 'address' })
      } else {
        setAmountError(message)
      }
    }
  }, [onchain, address])

  // --- Amount next (go to review) ---
  const handleAmountNext = useCallback(async () => {
    if (onchain.status !== 'ready') return
    setAmountError(null)

    if (amountSats <= 0n) return

    if (amountSats < MIN_DUST_SATS) {
      setAmountError('Amount must be at least 294 sats')
      return
    }

    if (amountSats > balance) {
      setAmountError('Amount exceeds available balance')
      return
    }

    try {
      const estimate = await onchain.estimateFee(address.trim(), amountSats)
      setSendStep({
        step: 'reviewing',
        address: address.trim(),
        amount: amountSats,
        fee: estimate.fee,
        feeRate: estimate.feeRate,
        isSendMax: false,
      })
    } catch (err) {
      const { field, message } = classifyEstimateError(err)
      if (field === 'address') {
        setAddressError(message)
        setSendStep({ step: 'address' })
      } else {
        setAmountError(message)
      }
    }
  }, [onchain, amountSats, balance, address])

  // --- Confirm send ---
  const handleConfirm = useCallback(async () => {
    if (sendingRef.current) return
    if (onchain.status !== 'ready' || sendStep.step !== 'reviewing') return

    sendingRef.current = true
    const sentAmount = sendStep.amount
    setSendStep({ step: 'broadcasting' })

    try {
      const txid = sendStep.isSendMax
        ? await onchain.sendMax(sendStep.address, sendStep.feeRate)
        : await onchain.sendToAddress(sendStep.address, sendStep.amount, sendStep.feeRate)
      setSendStep({ step: 'success', txid, amount: sentAmount })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSendStep({ step: 'error', message })
    } finally {
      sendingRef.current = false
    }
  }, [onchain, sendStep])

  // --- Loading / error gates ---
  if (onchain.status === 'loading') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-dark">
        <p className="text-[var(--color-on-dark-muted)]">Loading wallet...</p>
      </div>
    )
  }

  if (onchain.status === 'error') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-dark px-6">
        <p className="text-lg font-semibold text-on-dark">Failed to load wallet</p>
        <p className="mt-2 text-sm text-red-400">{onchain.error.message}</p>
        <button
          className="mt-6 text-sm text-accent"
          onClick={() => void navigate('/')}
        >
          Back to Home
        </button>
      </div>
    )
  }

  // --- Success screen ---
  if (sendStep.step === 'success') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-dark px-8 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-accent">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-10 w-10 text-white"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <div>
          <div className="font-display text-4xl font-bold text-on-dark">
            {formatBtc(sendStep.amount)}
          </div>
          <div className="mt-1 text-[var(--color-on-dark-muted)]">
            sent successfully
          </div>
        </div>
        {TXID_RE.test(sendStep.txid) ? (
          <a
            href={`${ONCHAIN_CONFIG.explorerUrl}/tx/${sendStep.txid}`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-accent px-6 py-3 text-sm text-accent transition-colors hover:bg-accent/10"
          >
            View on explorer
          </a>
        ) : (
          <p className="font-mono text-sm text-[var(--color-on-dark-muted)] break-all">{sendStep.txid}</p>
        )}
        <button
          className="mt-4 h-14 w-full max-w-[280px] rounded-xl bg-white font-display text-lg font-bold text-dark transition-transform active:scale-[0.98]"
          onClick={() => void navigate('/')}
        >
          Done
        </button>
      </div>
    )
  }

  // --- Error screen ---
  if (sendStep.step === 'error') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-dark px-8 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-red-500/20">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-10 w-10 text-red-400"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </div>
        <div>
          <div className="font-display text-2xl font-bold text-on-dark">
            Send Failed
          </div>
          <div className="mt-2 text-sm text-red-400">{sendStep.message}</div>
          <div className="mt-1 text-sm text-[var(--color-on-dark-muted)]">
            Your funds are safe.
          </div>
        </div>
        <button
          className="mt-4 h-14 w-full max-w-[280px] rounded-xl bg-white font-display text-lg font-bold text-dark transition-transform active:scale-[0.98]"
          onClick={() => setSendStep({ step: 'amount' })}
        >
          Try Again
        </button>
      </div>
    )
  }

  // --- Broadcasting screen ---
  if (sendStep.step === 'broadcasting') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-dark">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        <p className="text-[var(--color-on-dark-muted)]">Sending...</p>
      </div>
    )
  }

  // --- Review screen ---
  if (sendStep.step === 'reviewing') {
    const total = sendStep.amount + sendStep.fee
    return (
      <div className="flex min-h-dvh flex-col justify-between bg-dark text-on-dark">
        <ScreenHeader title="Review" onBack={() => setSendStep({ step: 'amount' })} />
        <div className="flex flex-1 flex-col gap-6 px-6 pt-8">
          <div className="flex justify-between">
            <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">To</span>
            <span className="max-w-[60%] break-all text-right font-mono text-sm font-semibold">
              {sendStep.address.slice(0, 12)}...{sendStep.address.slice(-8)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">Amount</span>
            <span className="font-semibold">{formatBtc(sendStep.amount)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">
              Network fee ({sendStep.feeRate.toString()} sat/vB)
            </span>
            <span className="font-semibold">{formatBtc(sendStep.fee)}</span>
          </div>
          <hr className="border-dark-border" />
          <div className="flex justify-between">
            <span className="text-lg font-semibold">Total</span>
            <span className="font-display text-3xl font-bold">{formatBtc(total)}</span>
          </div>
        </div>
        <div className="px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-4">
          <button
            className="h-14 w-full rounded-xl bg-accent font-display text-lg font-bold text-white transition-transform active:scale-[0.98]"
            onClick={() => void handleConfirm()}
          >
            Confirm Send
          </button>
        </div>
      </div>
    )
  }

  // --- Amount screen (numpad) ---
  if (sendStep.step === 'amount') {
    return (
      <div className="flex min-h-dvh flex-col justify-between bg-dark text-on-dark">
        <ScreenHeader title="Send" onBack={() => setSendStep({ step: 'address' })} />
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <button
            className="text-sm text-[var(--color-on-dark-muted)] transition-colors hover:text-on-dark"
            onClick={() => void handleSendMax()}
          >
            {formatBtc(balance)} available
          </button>
          <div
            className={`font-display font-bold leading-none tracking-tight ${
              amountDigits.length > 5 ? 'text-5xl' : 'text-7xl'
            }`}
            aria-live="polite"
          >
            {formatBtc(amountSats)}
          </div>
          {amountError && (
            <p className="mt-1 text-sm text-red-400">{amountError}</p>
          )}
        </div>
        <Numpad
          onKey={handleNumpadKey}
          onNext={() => void handleAmountNext()}
          nextDisabled={amountSats <= 0n}
        />
      </div>
    )
  }

  // --- Address screen ---
  return (
    <div className="flex min-h-dvh flex-col bg-dark text-on-dark">
      <ScreenHeader title="Send" backTo="/" />
      <div className="flex flex-1 flex-col gap-5 px-6 pt-6">
        <div className="flex flex-col gap-2">
          <label htmlFor="send-address" className="text-sm font-medium text-[var(--color-on-dark-muted)]">
            Recipient Address
          </label>
          <input
            id="send-address"
            type="text"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value)
              setAddressError(null)
            }}
            onPaste={handleAddressPaste}
            placeholder="tb1q... or bitcoin:tb1q..."
            maxLength={200}
            className="w-full rounded-xl border border-dark-border bg-dark-elevated px-4 py-3 font-mono text-sm text-on-dark placeholder:text-[var(--color-on-dark-muted)] focus:outline-none focus:ring-2 focus:ring-accent"
          />
          {addressError && (
            <p className="text-sm text-red-400">{addressError}</p>
          )}
        </div>
      </div>
      <div className="px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-4">
        <button
          className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-white font-display text-lg font-bold uppercase tracking-wider text-dark transition-transform disabled:cursor-not-allowed disabled:opacity-30 active:scale-[0.98]"
          onClick={handleAddressNext}
          disabled={!address.trim()}
        >
          Next
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5"
          >
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
        </button>
      </div>
    </div>
  )
}
