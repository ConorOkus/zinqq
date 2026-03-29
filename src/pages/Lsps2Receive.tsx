import { useState, useEffect, useCallback, useRef } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { useLdk } from '../ldk/use-ldk'
import { ScreenHeader } from '../components/ScreenHeader'
import { Numpad, type NumpadKey } from '../components/Numpad'
import { numpadDigitReducer } from '../components/numpad-reducer'
import { formatBtc } from '../utils/format-btc'

const MAX_DIGITS = 8

type JitState =
  | { step: 'idle' }
  | { step: 'negotiating' }
  | { step: 'ready'; openingFeeSats: bigint }
  | { step: 'error'; message: string }

export function Lsps2Receive() {
  const ldk = useLdk()
  const [invoice, setInvoice] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [editingAmount, setEditingAmount] = useState(true)
  const [amountDigits, setAmountDigits] = useState('')
  const [confirmedAmountDigits, setConfirmedAmountDigits] = useState('')
  const [jitState, setJitState] = useState<JitState>({ step: 'idle' })
  const amountButtonRef = useRef<HTMLButtonElement>(null)
  const processingRef = useRef(false)
  const requestJitInvoice = ldk.status === 'ready' ? ldk.requestJitInvoice : null

  const confirmedAmountSats = confirmedAmountDigits ? BigInt(confirmedAmountDigits) : 0n
  const editingAmountSats = amountDigits ? BigInt(amountDigits) : 0n

  // Request JIT invoice when amount is confirmed
  useEffect(() => {
    if (!requestJitInvoice || confirmedAmountSats <= 0n) return
    if (processingRef.current) return
    processingRef.current = true
    let stale = false

    setJitState({ step: 'negotiating' })
    setInvoice(null)

    const amountMsat = confirmedAmountSats * 1000n
    requestJitInvoice(amountMsat, 'zinqq wallet')
      .then((result) => {
        if (stale) return
        setInvoice(result.bolt11)
        setJitState({ step: 'ready', openingFeeSats: result.openingFeeMsat / 1000n })
      })
      .catch((err: unknown) => {
        if (stale) return
        const message = err instanceof Error ? err.message : 'Failed to set up Lightning receive'
        setJitState({ step: 'error', message })
        setInvoice(null)
      })
      .finally(() => {
        processingRef.current = false
      })

    return () => {
      stale = true
    }
  }, [requestJitInvoice, confirmedAmountSats])

  const handleCopy = useCallback(async () => {
    if (!invoice) return
    try {
      await navigator.clipboard.writeText(invoice)
      setCopied(true)
    } catch {
      // Invoice is displayed and selectable as fallback
    }
  }, [invoice])

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(id)
  }, [copied])

  const handleNumpadKey = useCallback((key: NumpadKey) => {
    setAmountDigits((prev) => numpadDigitReducer(prev, key, MAX_DIGITS))
  }, [])

  const handleConfirmAmount = useCallback(() => {
    setConfirmedAmountDigits(amountDigits)
    setEditingAmount(false)
    requestAnimationFrame(() => amountButtonRef.current?.focus())
  }, [amountDigits])

  const handleCancelAmount = useCallback(() => {
    setAmountDigits(confirmedAmountDigits)
    setEditingAmount(false)
    requestAnimationFrame(() => amountButtonRef.current?.focus())
  }, [confirmedAmountDigits])

  const handleRemoveAmount = useCallback(() => {
    setAmountDigits('')
    setConfirmedAmountDigits('')
    setJitState({ step: 'idle' })
    setInvoice(null)
    setEditingAmount(true)
  }, [])

  const handleEditAmount = useCallback(() => {
    setAmountDigits(confirmedAmountDigits)
    setEditingAmount(true)
  }, [confirmedAmountDigits])

  if (ldk.status === 'loading') {
    return (
      <div className="flex min-h-dvh flex-col bg-dark text-on-dark">
        <ScreenHeader title="LSPS2 Receive" backTo="/settings/advanced" />
        <div className="flex flex-1 items-center justify-center">
          <p className="text-[var(--color-on-dark-muted)]">Loading wallet...</p>
        </div>
      </div>
    )
  }

  if (ldk.status === 'error') {
    return (
      <div className="flex min-h-dvh flex-col bg-dark text-on-dark">
        <ScreenHeader title="LSPS2 Receive" backTo="/settings/advanced" />
        <div className="flex flex-1 flex-col items-center justify-center px-6">
          <p className="text-lg font-semibold text-on-dark">Failed to load wallet</p>
          <p className="mt-2 text-sm text-red-400">{ldk.error.message}</p>
        </div>
      </div>
    )
  }

  const qrValue = invoice ? invoice.toUpperCase() : ''
  const truncated = invoice ? `${invoice.slice(0, 16)}...${invoice.slice(-6)}` : ''

  return (
    <div className="flex min-h-dvh flex-col bg-dark text-on-dark">
      <ScreenHeader title="LSPS2 Receive" backTo="/settings/advanced" />

      {editingAmount ? (
        <div className="flex flex-1 flex-col">
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8">
            {confirmedAmountSats > 0n && (
              <button
                className="text-sm text-[var(--color-on-dark-muted)] transition-colors active:text-accent"
                onClick={handleCancelAmount}
              >
                Cancel
              </button>
            )}
            <p
              className={`font-display font-bold text-on-dark ${amountDigits.length > 5 ? 'text-5xl' : 'text-7xl'}`}
              aria-live="polite"
            >
              {formatBtc(editingAmountSats)}
            </p>
            {confirmedAmountSats > 0n && (
              <button
                className="text-sm text-red-400 transition-colors active:text-red-300"
                onClick={handleRemoveAmount}
              >
                Remove amount
              </button>
            )}
          </div>
          <Numpad
            onKey={handleNumpadKey}
            onNext={handleConfirmAmount}
            nextDisabled={editingAmountSats <= 0n}
            nextLabel="Request"
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col">
          <div className="flex flex-1 flex-col items-center justify-center gap-8 px-8">
            {jitState.step === 'error' && (
              <p className="text-sm text-red-400">{jitState.message}</p>
            )}
            {jitState.step === 'negotiating' && (
              <p className="text-sm text-[var(--color-on-dark-muted)]">
                Setting up Lightning receive...
              </p>
            )}

            {confirmedAmountSats > 0n && (
              <button
                className="text-sm text-accent transition-colors active:text-accent/80"
                onClick={handleEditAmount}
              >
                <span className="font-display text-lg font-bold text-on-dark">
                  {formatBtc(confirmedAmountSats)}
                </span>
              </button>
            )}

            {invoice && (
              <>
                <div
                  className="flex h-[260px] w-[260px] items-center justify-center rounded-2xl bg-white p-5"
                  aria-label={`QR code for JIT Lightning invoice, amount ${formatBtc(confirmedAmountSats)}`}
                >
                  <QRCodeSVG value={qrValue} size={220} />
                </div>

                {jitState.step === 'ready' && (
                  <p className="text-xs text-[var(--color-on-dark-muted)]">
                    Opening fee: {formatBtc(jitState.openingFeeSats)}
                  </p>
                )}

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

          <div className="px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-4">
            <button
              ref={amountButtonRef}
              className="flex h-14 w-full items-center justify-center rounded-xl bg-dark-elevated text-sm font-semibold text-accent transition-transform active:scale-[0.98]"
              onClick={handleEditAmount}
            >
              Edit amount
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
