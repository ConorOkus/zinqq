import { useState, useCallback, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { useOnchain } from '../onchain/use-onchain'
import { useLdk } from '../ldk/use-ldk'
import { classifyPaymentInput, type ParsedPaymentInput } from '../ldk/payment-input'
import { ONCHAIN_CONFIG } from '../onchain/config'
import { formatBtc } from '../utils/format-btc'
import { bytesToHex } from '../ldk/utils'
import { ScreenHeader } from '../components/ScreenHeader'
import { Numpad, type NumpadKey } from '../components/Numpad'
import { Check, XClose, ArrowRight } from '../components/icons'
import {
  RecentPaymentDetails_AwaitingInvoice,
  RecentPaymentDetails_Pending,
  RecentPaymentDetails_Fulfilled,
  RecentPaymentDetails_Abandoned,
} from 'lightningdevkit'

// --- State machine ---

type SendStep =
  // Shared entry
  | { step: 'input' }
  // On-chain flow
  | { step: 'oc-amount'; address: string }
  | {
      step: 'oc-review'
      address: string
      amount: bigint
      fee: bigint
      feeRate: bigint
      isSendMax: boolean
    }
  | { step: 'oc-broadcasting' }
  | { step: 'oc-success'; txid: string; amount: bigint }
  // Lightning flow
  | { step: 'ln-amount'; parsed: ParsedPaymentInput & { type: 'bolt11' | 'bolt12' | 'bip353' } }
  | {
      step: 'ln-review'
      parsed: ParsedPaymentInput & { type: 'bolt11' | 'bolt12' | 'bip353' }
      amountMsat: bigint
    }
  | {
      step: 'ln-sending'
      parsed: ParsedPaymentInput & { type: 'bolt11' | 'bolt12' | 'bip353' }
      amountMsat: bigint
      paymentId: Uint8Array
    }
  | { step: 'ln-success'; preimage: Uint8Array; amountMsat: bigint }
  // Shared
  | { step: 'error'; message: string; canRetry: boolean }

const MIN_DUST_SATS = 294n
const TXID_RE = /^[0-9a-f]{64}$/i
const MAX_DIGITS = 8
const PAYMENT_POLL_MS = 1_000
const MAX_POLL_DURATION_MS = 5 * 60 * 1_000

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

/** Convert millisatoshis to satoshis, rounding up. */
function msatToSat(msat: bigint): bigint {
  return (msat + 999n) / 1000n
}

/** Get a display label for a Lightning payment recipient. */
function recipientLabel(parsed: ParsedPaymentInput & { type: 'bolt11' | 'bolt12' | 'bip353' }): string {
  switch (parsed.type) {
    case 'bolt11':
      return parsed.description ?? 'Lightning Invoice'
    case 'bolt12':
      return parsed.description ?? 'Lightning Offer'
    case 'bip353':
      return parsed.raw
  }
}

/** Get a short badge label for the payment type. */
function typeBadge(parsed: ParsedPaymentInput & { type: 'bolt11' | 'bolt12' | 'bip353' }): string {
  switch (parsed.type) {
    case 'bolt11': return 'BOLT 11'
    case 'bolt12': return 'BOLT 12'
    case 'bip353': return 'BIP 353'
  }
}

export function Send() {
  const navigate = useNavigate()
  const onchain = useOnchain()
  const ldk = useLdk()
  const [sendStep, setSendStep] = useState<SendStep>({ step: 'input' })
  const [inputValue, setInputValue] = useState('')
  const [amountDigits, setAmountDigits] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)
  const [amountError, setAmountError] = useState<string | null>(null)
  const sendingRef = useRef(false)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const onchainBalance =
    onchain.status === 'ready'
      ? onchain.balance.confirmed + onchain.balance.trustedPending
      : 0n
  const lnCapacityMsat = ldk.status === 'ready' ? ldk.outboundCapacityMsat() : 0n

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    }
  }, [])

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

  // --- Input classification on paste ---
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLInputElement>) => {
      const pasted = e.clipboardData.getData('text')
      if (!pasted.trim()) return

      e.preventDefault()
      const parsed = classifyPaymentInput(pasted)

      if (parsed.type === 'error') {
        setInputValue(pasted)
        setInputError(parsed.message)
        return
      }

      if (parsed.type === 'onchain') {
        setInputValue(parsed.address)
        if (parsed.amountSats) {
          setAmountDigits(parsed.amountSats.toString())
        }
        setInputError(null)
        setSendStep({ step: 'oc-amount', address: parsed.address })
        return
      }

      // Lightning types
      setInputValue(pasted)
      setInputError(null)

      if ((parsed.type === 'bolt11' || parsed.type === 'bolt12') && parsed.amountMsat !== null) {
        // Fixed-amount invoice — check capacity before review
        if (parsed.amountMsat > lnCapacityMsat) {
          setInputError('Amount exceeds Lightning channel capacity')
          return
        }
        setSendStep({ step: 'ln-review', parsed, amountMsat: parsed.amountMsat })
      } else {
        // Needs amount input
        setSendStep({ step: 'ln-amount', parsed })
      }
    },
    [lnCapacityMsat],
  )

  // --- Input next button (manual entry) ---
  const handleInputNext = useCallback(() => {
    const trimmed = inputValue.trim()
    if (!trimmed) {
      setInputError('Paste an invoice, offer, or address')
      return
    }

    const parsed = classifyPaymentInput(trimmed)

    if (parsed.type === 'error') {
      setInputError(parsed.message)
      return
    }

    if (parsed.type === 'onchain') {
      setInputError(null)
      setSendStep({ step: 'oc-amount', address: parsed.address })
      return
    }

    setInputError(null)

    if ((parsed.type === 'bolt11' || parsed.type === 'bolt12') && parsed.amountMsat !== null) {
      if (parsed.amountMsat > lnCapacityMsat) {
        setInputError('Amount exceeds Lightning channel capacity')
        return
      }
      setSendStep({ step: 'ln-review', parsed, amountMsat: parsed.amountMsat })
    } else {
      setSendStep({ step: 'ln-amount', parsed })
    }
  }, [inputValue, lnCapacityMsat])

  // --- On-chain: Send max ---
  const handleSendMax = useCallback(async () => {
    if (onchain.status !== 'ready' || sendStep.step !== 'oc-amount') return
    setAmountError(null)
    try {
      const estimate = await onchain.estimateMaxSendable(sendStep.address)
      if (estimate.amount <= 0n) {
        setAmountError('Balance too low to cover fees')
        return
      }
      setSendStep({
        step: 'oc-review',
        address: sendStep.address,
        amount: estimate.amount,
        fee: estimate.fee,
        feeRate: estimate.feeRate,
        isSendMax: true,
      })
    } catch (err) {
      const { field, message } = classifyEstimateError(err)
      if (field === 'address') {
        setInputError(message)
        setSendStep({ step: 'input' })
      } else {
        setAmountError(message)
      }
    }
  }, [onchain, sendStep])

  // --- On-chain: Amount next ---
  const handleOcAmountNext = useCallback(async () => {
    if (onchain.status !== 'ready' || sendStep.step !== 'oc-amount') return
    setAmountError(null)

    if (amountSats <= 0n) return
    if (amountSats < MIN_DUST_SATS) {
      setAmountError('Amount must be at least 294 sats')
      return
    }
    if (amountSats > onchainBalance) {
      setAmountError('Amount exceeds available balance')
      return
    }

    try {
      const estimate = await onchain.estimateFee(sendStep.address, amountSats)
      setSendStep({
        step: 'oc-review',
        address: sendStep.address,
        amount: amountSats,
        fee: estimate.fee,
        feeRate: estimate.feeRate,
        isSendMax: false,
      })
    } catch (err) {
      const { field, message } = classifyEstimateError(err)
      if (field === 'address') {
        setInputError(message)
        setSendStep({ step: 'input' })
      } else {
        setAmountError(message)
      }
    }
  }, [onchain, amountSats, onchainBalance, sendStep])

  // --- On-chain: Confirm send ---
  const handleOcConfirm = useCallback(async () => {
    if (sendingRef.current) return
    if (onchain.status !== 'ready' || sendStep.step !== 'oc-review') return

    sendingRef.current = true
    const sentAmount = sendStep.amount
    setSendStep({ step: 'oc-broadcasting' })

    try {
      const txid = sendStep.isSendMax
        ? await onchain.sendMax(sendStep.address, sendStep.feeRate)
        : await onchain.sendToAddress(sendStep.address, sendStep.amount, sendStep.feeRate)
      setSendStep({ step: 'oc-success', txid, amount: sentAmount })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSendStep({ step: 'error', message, canRetry: true })
    } finally {
      sendingRef.current = false
    }
  }, [onchain, sendStep])

  // --- Lightning: Amount next ---
  const handleLnAmountNext = useCallback(() => {
    if (sendStep.step !== 'ln-amount') return
    setAmountError(null)

    if (amountSats <= 0n) return

    const amountMsat = amountSats * 1000n

    if (amountMsat > lnCapacityMsat) {
      setAmountError('Amount exceeds Lightning channel capacity')
      return
    }

    setSendStep({ step: 'ln-review', parsed: sendStep.parsed, amountMsat })
  }, [sendStep, amountSats, lnCapacityMsat])

  // --- Lightning: Confirm send ---
  const handleLnConfirm = useCallback(() => {
    if (sendingRef.current) return
    if (ldk.status !== 'ready' || sendStep.step !== 'ln-review') return

    sendingRef.current = true
    const { parsed, amountMsat } = sendStep

    try {
      let paymentId: Uint8Array

      switch (parsed.type) {
        case 'bolt11':
          paymentId = ldk.sendBolt11Payment(
            parsed.invoice,
            parsed.amountMsat === null ? amountMsat : undefined,
          )
          break
        case 'bolt12':
          paymentId = ldk.sendBolt12Payment(
            parsed.offer,
            parsed.amountMsat === null ? amountMsat : undefined,
          )
          break
        case 'bip353':
          paymentId = ldk.sendBip353Payment(parsed.name, amountMsat)
          break
      }

      setSendStep({ step: 'ln-sending', parsed, amountMsat, paymentId })

      // Start polling for payment result with timeout
      const startTime = Date.now()
      const intervalId = setInterval(() => {
        const stopPolling = () => {
          clearInterval(intervalId)
          pollTimerRef.current = null
          sendingRef.current = false
        }

        // Timeout after 5 minutes
        if (Date.now() - startTime > MAX_POLL_DURATION_MS) {
          stopPolling()
          setSendStep({ step: 'error', message: 'Payment timed out', canRetry: false })
          return
        }

        // Check event-based result
        const result = ldk.getPaymentResult(paymentId)
        if (result && result.status === 'sent') {
          stopPolling()
          setSendStep({ step: 'ln-success', preimage: result.preimage, amountMsat })
          return
        }
        if (result && result.status === 'failed') {
          stopPolling()
          setSendStep({ step: 'error', message: result.reason, canRetry: false })
          return
        }

        // Also check list_recent_payments for BOLT 12 state transitions
        const paymentIdHex = bytesToHex(paymentId)
        const recent = ldk.listRecentPayments()
        for (const p of recent) {
          if (p instanceof RecentPaymentDetails_Fulfilled && bytesToHex(p.payment_id) === paymentIdHex) {
            stopPolling()
            const eventResult = ldk.getPaymentResult(paymentId)
            const preimage = eventResult?.status === 'sent' ? eventResult.preimage : new Uint8Array(32)
            setSendStep({ step: 'ln-success', preimage, amountMsat })
            return
          }
          if (p instanceof RecentPaymentDetails_Abandoned && bytesToHex(p.payment_id) === paymentIdHex) {
            stopPolling()
            setSendStep({ step: 'error', message: 'Payment was abandoned', canRetry: false })
            return
          }
        }
      }, PAYMENT_POLL_MS)
      pollTimerRef.current = intervalId
    } catch (err) {
      sendingRef.current = false
      const message = err instanceof Error ? err.message : String(err)
      setSendStep({ step: 'error', message, canRetry: false })
    }
  }, [ldk, sendStep])

  // --- Lightning: Cancel payment ---
  const handleCancelPayment = useCallback(() => {
    if (ldk.status !== 'ready' || sendStep.step !== 'ln-sending') return
    ldk.abandonPayment(sendStep.paymentId)
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
    sendingRef.current = false
    setSendStep({ step: 'error', message: 'Payment cancelled', canRetry: false })
  }, [ldk, sendStep])

  // --- Loading / error gates ---
  if (onchain.status === 'loading' || ldk.status === 'loading') {
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
        <button className="mt-6 text-sm text-accent" onClick={() => void navigate('/')}>
          Back to Home
        </button>
      </div>
    )
  }

  // --- On-chain success ---
  if (sendStep.step === 'oc-success') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-dark px-8 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-accent">
          <Check className="h-10 w-10 text-white" />
        </div>
        <div>
          <div className="font-display text-4xl font-bold text-on-dark">
            {formatBtc(sendStep.amount)}
          </div>
          <div className="mt-1 text-[var(--color-on-dark-muted)]">sent successfully</div>
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
          <p className="font-mono text-sm text-[var(--color-on-dark-muted)] break-all">
            {sendStep.txid}
          </p>
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

  // --- Lightning success ---
  if (sendStep.step === 'ln-success') {
    const preimageHex = bytesToHex(sendStep.preimage)
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-dark px-8 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-accent">
          <Check className="h-10 w-10 text-white" />
        </div>
        <div>
          <div className="font-display text-4xl font-bold text-on-dark">
            {formatBtc(msatToSat(sendStep.amountMsat))}
          </div>
          <div className="mt-1 text-[var(--color-on-dark-muted)]">sent via Lightning</div>
        </div>
        {preimageHex !== '0'.repeat(64) && (
          <button
            className="rounded-full border border-dark-border px-4 py-2 font-mono text-xs text-[var(--color-on-dark-muted)] transition-colors hover:bg-white/5"
            onClick={() => void navigator.clipboard.writeText(preimageHex)}
            title="Copy preimage"
          >
            {preimageHex.slice(0, 8)}...{preimageHex.slice(-8)}
          </button>
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
          <XClose className="h-10 w-10 text-red-400" />
        </div>
        <div>
          <div className="font-display text-2xl font-bold text-on-dark">Send Failed</div>
          <div className="mt-2 text-sm text-red-400">{sendStep.message}</div>
          <div className="mt-1 text-sm text-[var(--color-on-dark-muted)]">Your funds are safe.</div>
        </div>
        <button
          className="mt-4 h-14 w-full max-w-[280px] rounded-xl bg-white font-display text-lg font-bold text-dark transition-transform active:scale-[0.98]"
          onClick={() => {
            setAmountDigits('')
            setSendStep({ step: 'input' })
          }}
        >
          {sendStep.canRetry ? 'Try Again' : 'Done'}
        </button>
      </div>
    )
  }

  // --- On-chain broadcasting ---
  if (sendStep.step === 'oc-broadcasting') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-dark">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        <p className="text-[var(--color-on-dark-muted)]">Broadcasting transaction...</p>
      </div>
    )
  }

  // --- Lightning sending ---
  if (sendStep.step === 'ln-sending') {
    // Determine display status based on list_recent_payments
    let statusText = 'Sending payment...'
    if (ldk.status === 'ready') {
      const recent = ldk.listRecentPayments()
      const paymentIdHex = bytesToHex(sendStep.paymentId)
      for (const p of recent) {
        if (p instanceof RecentPaymentDetails_AwaitingInvoice && bytesToHex(p.payment_id) === paymentIdHex) {
          statusText = 'Requesting invoice...'
          break
        }
        if (p instanceof RecentPaymentDetails_Pending && bytesToHex(p.payment_id) === paymentIdHex) {
          statusText = 'Sending payment...'
          break
        }
      }
    }

    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-dark">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        <p className="text-[var(--color-on-dark-muted)]">{statusText}</p>
        <div className="mt-1 text-xs text-[var(--color-on-dark-muted)]">
          {formatBtc(msatToSat(sendStep.amountMsat))}
        </div>
        <button
          className="mt-4 text-sm text-red-400 transition-colors hover:text-red-300"
          onClick={handleCancelPayment}
        >
          Cancel
        </button>
      </div>
    )
  }

  // --- On-chain review ---
  if (sendStep.step === 'oc-review') {
    const total = sendStep.amount + sendStep.fee
    return (
      <div className="flex min-h-dvh flex-col justify-between bg-dark text-on-dark">
        <ScreenHeader title="Review" onBack={() => setSendStep({ step: 'oc-amount', address: sendStep.address })} />
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
            onClick={() => void handleOcConfirm()}
          >
            Confirm Send
          </button>
        </div>
      </div>
    )
  }

  // --- Lightning review ---
  if (sendStep.step === 'ln-review') {
    const { parsed, amountMsat } = sendStep
    return (
      <div className="flex min-h-dvh flex-col justify-between bg-dark text-on-dark">
        <ScreenHeader
          title="Review"
          onBack={() => {
            if ((parsed.type === 'bolt11' || parsed.type === 'bolt12') && parsed.amountMsat !== null) {
              setSendStep({ step: 'input' })
            } else {
              setAmountDigits(msatToSat(amountMsat).toString())
              setSendStep({ step: 'ln-amount', parsed })
            }
          }}
        />
        <div className="flex flex-1 flex-col gap-6 px-6 pt-8">
          <div className="flex justify-between">
            <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">To</span>
            <span className="max-w-[60%] break-all text-right text-sm font-semibold">
              {recipientLabel(parsed)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">Type</span>
            <span className="rounded-full bg-accent/20 px-3 py-0.5 text-xs font-semibold text-accent">
              {typeBadge(parsed)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">Amount</span>
            <span className="font-display text-3xl font-bold">{formatBtc(msatToSat(amountMsat))}</span>
          </div>
        </div>
        <div className="px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-4">
          <button
            className="h-14 w-full rounded-xl bg-accent font-display text-lg font-bold text-white transition-transform active:scale-[0.98]"
            onClick={handleLnConfirm}
          >
            Confirm Send
          </button>
        </div>
      </div>
    )
  }

  // --- On-chain amount (numpad) ---
  if (sendStep.step === 'oc-amount') {
    return (
      <div className="flex min-h-dvh flex-col justify-between bg-dark text-on-dark">
        <ScreenHeader title="Send" onBack={() => setSendStep({ step: 'input' })} />
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <button
            className="text-sm text-[var(--color-on-dark-muted)] transition-colors hover:text-on-dark"
            onClick={() => void handleSendMax()}
          >
            {formatBtc(onchainBalance)} available
          </button>
          <div
            className={`font-display font-bold leading-none tracking-tight ${
              amountDigits.length > 5 ? 'text-5xl' : 'text-7xl'
            }`}
            aria-live="polite"
          >
            {formatBtc(amountSats)}
          </div>
          {amountError && <p className="mt-1 text-sm text-red-400">{amountError}</p>}
        </div>
        <Numpad
          onKey={handleNumpadKey}
          onNext={() => void handleOcAmountNext()}
          nextDisabled={amountSats <= 0n}
        />
      </div>
    )
  }

  // --- Lightning amount (numpad) ---
  if (sendStep.step === 'ln-amount') {
    const capacitySats = msatToSat(lnCapacityMsat)
    return (
      <div className="flex min-h-dvh flex-col justify-between bg-dark text-on-dark">
        <ScreenHeader title="Send" onBack={() => setSendStep({ step: 'input' })} />
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <div className="text-sm text-[var(--color-on-dark-muted)]">
            {formatBtc(capacitySats)} available
          </div>
          <div
            className={`font-display font-bold leading-none tracking-tight ${
              amountDigits.length > 5 ? 'text-5xl' : 'text-7xl'
            }`}
            aria-live="polite"
          >
            {formatBtc(amountSats)}
          </div>
          {amountError && <p className="mt-1 text-sm text-red-400">{amountError}</p>}
          <div className="mt-1 rounded-full bg-accent/20 px-3 py-0.5 text-xs font-semibold text-accent">
            {typeBadge(sendStep.parsed)}
          </div>
        </div>
        <Numpad
          onKey={handleNumpadKey}
          onNext={handleLnAmountNext}
          nextDisabled={amountSats <= 0n}
        />
      </div>
    )
  }

  // --- Input screen (unified entry point) ---
  return (
    <div className="flex min-h-dvh flex-col bg-dark text-on-dark">
      <ScreenHeader title="Send" backTo="/" />
      <div className="flex flex-1 flex-col gap-5 px-6 pt-6">
        <div className="flex flex-col gap-2">
          <label
            htmlFor="send-input"
            className="text-sm font-medium text-[var(--color-on-dark-muted)]"
          >
            Recipient
          </label>
          <input
            id="send-input"
            type="text"
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value)
              setInputError(null)
            }}
            onPaste={handlePaste}
            placeholder="Invoice, offer, address, or user@domain"
            maxLength={2000}
            className="w-full rounded-xl border border-dark-border bg-dark-elevated px-4 py-3 font-mono text-sm text-on-dark placeholder:text-[var(--color-on-dark-muted)] focus:outline-none focus:ring-2 focus:ring-accent"
          />
          {inputError && <p className="text-sm text-red-400">{inputError}</p>}
        </div>
      </div>
      <div className="px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-4">
        <button
          className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-white font-display text-lg font-bold uppercase tracking-wider text-dark transition-transform disabled:cursor-not-allowed disabled:opacity-30 active:scale-[0.98]"
          onClick={handleInputNext}
          disabled={!inputValue.trim()}
        >
          Next
          <ArrowRight className="h-5 w-5" />
        </button>
      </div>
    </div>
  )
}
