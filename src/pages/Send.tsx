import { useState, useCallback, useRef, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router'
import { useOnchain } from '../onchain/use-onchain'
import { useLdk } from '../ldk/use-ldk'
import { useUnifiedBalance } from '../hooks/use-unified-balance'
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
  // Recipient entry (first screen)
  | { step: 'recipient' }
  // Amount entry (shown only when input has no embedded amount)
  | { step: 'amount'; parsedInput: ParsedPaymentInput; rawInput: string }
  // On-chain flow
  | {
      step: 'oc-review'
      address: string
      amount: bigint
      fee: bigint
      feeRate: bigint
      isSendMax: boolean
      fromStep: 'recipient' | 'amount'
    }
  | { step: 'oc-broadcasting' }
  | { step: 'oc-success'; txid: string; amount: bigint }
  // Lightning flow
  | {
      step: 'ln-review'
      parsed: ParsedPaymentInput & { type: 'bolt11' | 'bolt12' | 'bip353' }
      amountMsat: bigint
      fromStep: 'recipient' | 'amount'
    }
  | {
      step: 'ln-sending'
      parsed: ParsedPaymentInput & { type: 'bolt11' | 'bolt12' | 'bip353' }
      amountMsat: bigint
      paymentId: Uint8Array
    }
  | { step: 'ln-success'; preimage: Uint8Array; amountMsat: bigint }
  // Shared
  | { step: 'error'; message: string; retryStep: ReviewStep | null }

type ReviewStep = Extract<SendStep, { step: 'oc-review' } | { step: 'ln-review' }>

const MIN_DUST_SATS = 294n
const TXID_RE = /^[0-9a-f]{64}$/i
const MAX_DIGITS = 8
const PAYMENT_POLL_MS = 1_000
const MAX_POLL_DURATION_MS = 5 * 60 * 1_000

function classifyEstimateError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('network') || msg.includes('different Bitcoin network')) {
    return 'This address is for a different Bitcoin network'
  }
  if (msg.includes('Invalid') || msg.includes('address')) {
    return 'Invalid Bitcoin address'
  }
  return msg
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
  const location = useLocation()
  const onchain = useOnchain()
  const ldk = useLdk()
  const unified = useUnifiedBalance()
  const [sendStep, setSendStep] = useState<SendStep>({ step: 'recipient' })
  const [inputValue, setInputValue] = useState('')
  const [amountDigits, setAmountDigits] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)
  const [isSendMax, setIsSendMax] = useState(false)
  const [pendingQrInput, setPendingQrInput] = useState<string | null>(null)
  const sendingRef = useRef(false)
  const processingRef = useRef(false)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Store amount step data so we can restore it when navigating back from review
  const amountStepDataRef = useRef<{ parsedInput: ParsedPaymentInput; rawInput: string } | null>(null)

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
    setIsSendMax(false)
    setInputError(null)
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

  // --- Amount screen: Send max approximation ---
  const handleApproxSendMax = useCallback(() => {
    if (unified.total <= 0n) return
    setAmountDigits(unified.total.toString())
    setIsSendMax(true)
  }, [unified.total])

  // --- Process input: classify and route to review or amount step ---
  const processRecipientInput = useCallback(async (value: string, fromStep: 'recipient' | 'amount') => {
    if (processingRef.current) return
    const trimmed = value.trim()
    if (!trimmed) {
      setInputError('Enter a payment request or address')
      return
    }

    processingRef.current = true
    try {
    const parsed = classifyPaymentInput(trimmed)

    if (parsed.type === 'error') {
      setInputError(parsed.message)
      return
    }

    setInputError(null)

    // Save amount step data for back navigation from review
    if (fromStep === 'amount') {
      amountStepDataRef.current = { parsedInput: parsed, rawInput: trimmed }
    } else {
      amountStepDataRef.current = null
    }

    if (parsed.type === 'onchain') {
      const hasEmbeddedAmount = parsed.amountSats !== null

      // If no amount and coming from recipient, go to numpad
      if (!hasEmbeddedAmount && fromStep === 'recipient') {
        setSendStep({ step: 'amount', parsedInput: parsed, rawInput: trimmed })
        return
      }

      // Use parsed amount if present (BIP 321 URI with ?amount=), otherwise use numpad amount
      const effectiveAmount = parsed.amountSats ?? amountSats
      const effectiveIsSendMax = parsed.amountSats ? false : isSendMax

      // Phase 2 validation: dust limit
      if (effectiveAmount < MIN_DUST_SATS) {
        setInputError('Amount must be at least 294 sats (dust limit)')
        return
      }

      if (onchain.status !== 'ready') return

      // Send max: recalculate exact amount with fee
      if (effectiveIsSendMax) {
        try {
          const estimate = await onchain.estimateMaxSendable(parsed.address)
          if (estimate.amount <= 0n) {
            setInputError('Balance too low to cover fees')
            return
          }
          setSendStep({
            step: 'oc-review',
            address: parsed.address,
            amount: estimate.amount,
            fee: estimate.fee,
            feeRate: estimate.feeRate,
            isSendMax: true,
            fromStep,
          })
        } catch (err) {
          const message = classifyEstimateError(err)
          setInputError(message)
        }
        return
      }

      // Validate against on-chain balance
      if (effectiveAmount > onchainBalance) {
        setInputError('Amount exceeds available on-chain balance')
        return
      }

      try {
        const estimate = await onchain.estimateFee(parsed.address, effectiveAmount)
        setSendStep({
          step: 'oc-review',
          address: parsed.address,
          amount: effectiveAmount,
          fee: estimate.fee,
          feeRate: estimate.feeRate,
          isSendMax: false,
          fromStep,
        })
      } catch (err) {
        const message = classifyEstimateError(err)
        setInputError(message)
      }
      return
    }

    // Lightning types (bolt11, bolt12, bip353)
    // Fixed-amount: use embedded amount, skip numpad
    if (parsed.type !== 'bip353' && parsed.amountMsat !== null) {
      if (parsed.amountMsat > lnCapacityMsat) {
        setInputError('Amount exceeds Lightning channel capacity')
        return
      }
      setSendStep({ step: 'ln-review', parsed, amountMsat: parsed.amountMsat, fromStep })
      return
    }

    // No embedded amount — need numpad
    if (fromStep === 'recipient') {
      setSendStep({ step: 'amount', parsedInput: parsed, rawInput: trimmed })
      return
    }

    // Coming from numpad — use user-entered amount
    const effectiveMsat = amountSats * 1000n
    if (effectiveMsat > lnCapacityMsat) {
      setInputError('Amount exceeds Lightning channel capacity')
      return
    }
    setSendStep({ step: 'ln-review', parsed, amountMsat: effectiveMsat, fromStep })
    } finally {
      processingRef.current = false
    }
  }, [amountSats, isSendMax, onchain, onchainBalance, lnCapacityMsat])

  // --- Recipient: paste handler ---
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLInputElement>) => {
      const pasted = e.clipboardData.getData('text')
      if (!pasted.trim()) return

      e.preventDefault()
      setInputValue(pasted)
      void processRecipientInput(pasted, 'recipient')
    },
    [processRecipientInput],
  )

  // --- Recipient: Next button ---
  const handleRecipientNext = useCallback(() => {
    void processRecipientInput(inputValue, 'recipient')
  }, [inputValue, processRecipientInput])

  // --- Amount screen: Next (process the stored recipient input with user-entered amount) ---
  const handleAmountNext = useCallback(() => {
    if (amountSats <= 0n) return
    if (sendStep.step !== 'amount') return
    void processRecipientInput(sendStep.rawInput, 'amount')
  }, [amountSats, sendStep, processRecipientInput])

  // QR scanner integration: consume scannedInput from location.state
  useEffect(() => {
    const state = location.state as Record<string, unknown> | null
    const raw = typeof state?.scannedInput === 'string' ? state.scannedInput : null
    if (!raw || raw.length > 2000) return
    void navigate('/send', { replace: true, state: null })
    setPendingQrInput(raw)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Process pending QR input once wallet is ready
  useEffect(() => {
    if (!pendingQrInput) return
    if (onchain.status !== 'ready') return
    const raw = pendingQrInput
    setPendingQrInput(null)
    setInputValue(raw)
    void processRecipientInput(raw, 'recipient')
  }, [pendingQrInput, onchain.status, processRecipientInput])

  // --- Review: Back navigation (shared by oc-review and ln-review) ---
  const handleReviewBack = useCallback(() => {
    if (sendStep.step !== 'oc-review' && sendStep.step !== 'ln-review') return
    if (sendStep.fromStep === 'amount' && amountStepDataRef.current) {
      setSendStep({ step: 'amount', ...amountStepDataRef.current })
    } else {
      setSendStep({ step: 'recipient' })
    }
  }, [sendStep])

  // --- On-chain: Confirm send ---
  const handleOcConfirm = useCallback(async () => {
    if (sendingRef.current) return
    if (onchain.status !== 'ready' || sendStep.step !== 'oc-review') return

    sendingRef.current = true
    const sentAmount = sendStep.amount
    const reviewStep = sendStep
    setSendStep({ step: 'oc-broadcasting' })

    try {
      const txid = sendStep.isSendMax
        ? await onchain.sendMax(sendStep.address, sendStep.feeRate)
        : await onchain.sendToAddress(sendStep.address, sendStep.amount, sendStep.feeRate)
      setSendStep({ step: 'oc-success', txid, amount: sentAmount })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSendStep({ step: 'error', message, retryStep: reviewStep })
    } finally {
      sendingRef.current = false
    }
  }, [onchain, sendStep])

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
          setSendStep({ step: 'error', message: 'Payment timed out', retryStep: null })
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
          setSendStep({ step: 'error', message: result.reason, retryStep: null })
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
            setSendStep({ step: 'error', message: 'Payment was abandoned', retryStep: null })
            return
          }
        }
      }, PAYMENT_POLL_MS)
      pollTimerRef.current = intervalId
    } catch (err) {
      sendingRef.current = false
      const message = err instanceof Error ? err.message : String(err)
      setSendStep({ step: 'error', message, retryStep: null })
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
    setSendStep({ step: 'error', message: 'Payment cancelled', retryStep: null })
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
            if (sendStep.retryStep) {
              setSendStep(sendStep.retryStep)
            } else {
              void navigate('/')
            }
          }}
        >
          {sendStep.retryStep ? 'Try Again' : 'Done'}
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
        <ScreenHeader title="Review" onBack={handleReviewBack} />
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
        <ScreenHeader title="Review" onBack={handleReviewBack} />
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

  // --- Amount screen (shown only when input has no embedded amount) ---
  if (sendStep.step === 'amount') {
    return (
      <div className="flex min-h-dvh flex-col justify-between bg-dark text-on-dark">
        <ScreenHeader title="Send" onBack={() => setSendStep({ step: 'recipient' })} />
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <button
            className="text-sm text-[var(--color-on-dark-muted)] transition-colors hover:text-on-dark"
            onClick={handleApproxSendMax}
          >
            {formatBtc(unified.total)} available
          </button>
          <div
            className={`font-display font-bold leading-none tracking-tight ${
              amountDigits.length > 5 ? 'text-5xl' : 'text-7xl'
            }`}
            aria-live="polite"
          >
            {formatBtc(amountSats)}
          </div>
          {inputError && <p className="mt-2 text-sm text-red-400">{inputError}</p>}
        </div>
        <Numpad
          onKey={handleNumpadKey}
          onNext={handleAmountNext}
          nextDisabled={amountSats <= 0n}
        />
      </div>
    )
  }

  // --- Recipient screen (first step, default) ---
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
            placeholder="payment request or user@domain"
            maxLength={2000}
            className="w-full rounded-xl border border-dark-border bg-dark-elevated px-4 py-3 font-mono text-sm text-on-dark placeholder:text-[var(--color-on-dark-muted)] focus:outline-none focus:ring-2 focus:ring-accent"
          />
          {inputError && <p className="text-sm text-red-400">{inputError}</p>}
        </div>
      </div>
      <div className="px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-4">
        <button
          className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-white font-display text-lg font-bold uppercase tracking-wider text-dark transition-transform disabled:cursor-not-allowed disabled:opacity-30 active:scale-[0.98]"
          onClick={handleRecipientNext}
          disabled={!inputValue.trim()}
        >
          Next
          <ArrowRight className="h-5 w-5" />
        </button>
      </div>
    </div>
  )
}
