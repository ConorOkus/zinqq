import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router'
import { QRCodeSVG } from 'qrcode.react'
import { useOnchain } from '../onchain/use-onchain'
import { useLdk } from '../ldk/use-ldk'
import { ScreenHeader } from '../components/ScreenHeader'
import { BottomSheet } from '../components/BottomSheet'
import { Numpad, type NumpadKey } from '../components/Numpad'
import { numpadDigitReducer } from '../components/numpad-reducer'
import { formatBtc } from '../utils/format-btc'
import { buildBip321Uri } from '../onchain/bip321'
import { CopyIcon } from '../components/icons'
import { captureError } from '../storage/error-log'

type QrPage = 'unified' | 'bolt12'

const MAX_DIGITS = 8

type InvoicePath = 'none' | 'standard' | 'jit'

type ReceiveState =
  | { step: 'ready'; invoicePath: InvoicePath }
  | { step: 'negotiating-jit' }
  | { step: 'success'; amountSats: bigint }

export function Receive() {
  const navigate = useNavigate()
  const onchain = useOnchain()
  const ldk = useLdk()
  const [address, setAddress] = useState<string | null>(null)
  const [invoice, setInvoice] = useState<string | null>(null)
  const [paymentHash, setPaymentHash] = useState<string | null>(null)
  const [openingFeeSats, setOpeningFeeSats] = useState<bigint | null>(null)
  const [addressError, setAddressError] = useState<string | null>(null)
  const [invoiceError, setInvoiceError] = useState<string | null>(null)
  const [receiveState, setReceiveState] = useState<ReceiveState>({
    step: 'ready',
    invoicePath: 'none',
  })
  const [copied, setCopied] = useState(false)
  const [showSheet, setShowSheet] = useState(false)
  const [editingAmount, setEditingAmount] = useState(false)
  const [amountDigits, setAmountDigits] = useState('')
  const [confirmedAmountDigits, setConfirmedAmountDigits] = useState('')
  const [activeQrPage, setActiveQrPage] = useState<QrPage>('unified')
  const overlayRef = useRef<HTMLDivElement>(null)
  const amountButtonRef = useRef<HTMLButtonElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const requestCounterRef = useRef(0)

  const generateAddress = onchain.status === 'ready' ? onchain.generateAddress : null
  const createInvoice = ldk.status === 'ready' ? ldk.createInvoice : null
  const requestJitInvoice = ldk.status === 'ready' ? ldk.requestJitInvoice : null
  const listChannels = ldk.status === 'ready' ? ldk.listChannels : null
  const peersReconnected = ldk.status === 'ready' ? ldk.peersReconnected : false
  const channelChangeCounter = ldk.status === 'ready' ? ldk.channelChangeCounter : 0
  const paymentHistory = ldk.status === 'ready' ? ldk.paymentHistory : []
  const bolt12Offer = ldk.status === 'ready' ? ldk.bolt12Offer : null

  const confirmedAmountSats = confirmedAmountDigits ? BigInt(confirmedAmountDigits) : 0n
  const editingAmountSats = amountDigits ? BigInt(amountDigits) : 0n

  // No usable channels → JIT is required → amount is required
  const needsAmount = useMemo(() => {
    if (!listChannels) return true
    return !listChannels().some((ch) => ch.get_is_usable())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listChannels, channelChangeCounter])

  // Start with numpad open when amount is required (first receive / no channels)
  const didInitAmountRef = useRef(false)
  useEffect(() => {
    if (!didInitAmountRef.current && ldk.status === 'ready' && needsAmount) {
      setEditingAmount(true)
      didInitAmountRef.current = true
    }
  }, [ldk.status, needsAmount])

  // Generate on-chain address on mount
  useEffect(() => {
    if (generateAddress && address === null && addressError === null) {
      try {
        setAddress(generateAddress())
      } catch (err) {
        captureError('error', 'Receive', 'Failed to generate address', String(err))
        setAddressError(err instanceof Error ? err.message : 'Failed to generate address')
      }
    }
  }, [generateAddress, address, addressError])

  // Generate invoice based on amount and inbound capacity.
  // Deps intentionally exclude channel state — inbound capacity is computed
  // inline so that channel changes (e.g. JIT channel opening) don't trigger
  // a re-run that would discard the in-flight JIT result.
  useEffect(() => {
    if (!createInvoice) return

    // Wait for peers to reconnect if channels exist but aren't usable yet
    if (!peersReconnected && listChannels && listChannels().length > 0) return

    const amountMsat = confirmedAmountSats > 0n ? confirmedAmountSats * 1000n : undefined

    // Compute inbound capacity inline (not memoized) so it doesn't appear in deps
    const channels = listChannels?.() ?? []
    let inboundMsat = 0n
    for (const ch of channels) {
      if (ch.get_is_usable()) {
        inboundMsat += ch.get_inbound_capacity_msat()
      }
    }
    const hasUsable = inboundMsat > 0n || channels.some((ch) => ch.get_is_usable())

    const needsJit = amountMsat !== undefined ? inboundMsat < amountMsat : !hasUsable

    if (needsJit && amountMsat === undefined) {
      // JIT needed but no amount -- show on-chain only
      setInvoice(null)
      setPaymentHash(null)
      setOpeningFeeSats(null)
      setInvoiceError(null)
      setReceiveState({ step: 'ready', invoicePath: 'none' })
      return
    }

    if (needsJit && requestJitInvoice && amountMsat !== undefined) {
      // LSPS2 JIT path — use a request counter so that only the latest
      // request's result is applied (handles amount changes mid-flight).
      const thisRequest = ++requestCounterRef.current

      setInvoice(null)
      setPaymentHash(null)
      setOpeningFeeSats(null)
      setInvoiceError(null)
      setReceiveState({ step: 'negotiating-jit' })

      requestJitInvoice(amountMsat, 'zinqq wallet')
        .then((result) => {
          if (requestCounterRef.current !== thisRequest) return
          setInvoice(result.bolt11)
          setPaymentHash(result.paymentHash)
          setOpeningFeeSats((result.openingFeeMsat + 999n) / 1000n)
          setReceiveState({ step: 'ready', invoicePath: 'jit' })
        })
        .catch((err: unknown) => {
          if (requestCounterRef.current !== thisRequest) return
          captureError('warning', 'Receive', 'JIT invoice failed', String(err))
          setInvoice(null)
          setPaymentHash(null)
          setOpeningFeeSats(null)
          setReceiveState({ step: 'ready', invoicePath: 'none' })
        })

      return
    }

    // Standard path
    try {
      const result = createInvoice(amountMsat)
      setInvoice(result.bolt11)
      setPaymentHash(result.paymentHash)
      setOpeningFeeSats(null)
      setInvoiceError(null)
      setReceiveState({ step: 'ready', invoicePath: 'standard' })
    } catch (err) {
      captureError('warning', 'Receive', 'Failed to create invoice', String(err))
      setInvoice(null)
      setPaymentHash(null)
      if (confirmedAmountSats > 0n) {
        setInvoiceError('Failed to create Lightning invoice')
      }
      setReceiveState({ step: 'ready', invoicePath: 'none' })
    }
    return () => {
      requestCounterRef.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createInvoice, requestJitInvoice, confirmedAmountSats, peersReconnected])

  // Watch payment history for success
  useEffect(() => {
    if (!paymentHash) return
    if (receiveState.step === 'success') return

    const match = paymentHistory.find(
      (p) => p.paymentHash === paymentHash && p.direction === 'inbound' && p.status === 'succeeded'
    )
    if (match) {
      setReceiveState({ step: 'success', amountSats: match.amountMsat / 1000n })
    }
  }, [paymentHistory, paymentHash, receiveState.step])

  // Focus trap: keep focus within overlay
  useEffect(() => {
    const el = overlayRef.current
    if (!el) return
    const getFocusable = () => el.querySelectorAll<HTMLElement>('button, a, input, [tabindex]')
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

  // Reset pager to unified page when BOLT 12 page is removed
  const showBolt12 = bolt12Offer && !needsAmount
  useEffect(() => {
    if (!showBolt12) setActiveQrPage('unified')
  }, [showBolt12])

  // Build BIP 321 URIs — lno lives on its own pager page, not in the unified URI
  const bip321Uri = address
    ? buildBip321Uri({
        address,
        amountSats: confirmedAmountSats,
        invoice,
      })
    : ''
  const bolt12Uri = bolt12Offer ? buildBip321Uri({ lno: bolt12Offer }) : ''

  const copyValue = activeQrPage === 'bolt12' && bolt12Uri ? bolt12Uri : bip321Uri

  const handleCopy = useCallback(async () => {
    if (!copyValue) return
    try {
      await navigator.clipboard.writeText(copyValue)
      setCopied(true)
    } catch {
      // Address is displayed and selectable as fallback
    }
  }, [copyValue])

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(id)
  }, [copied])

  const handleShare = useCallback(async () => {
    if (!copyValue || typeof navigator.share !== 'function') return
    try {
      await navigator.share({ text: copyValue })
    } catch {
      // User cancelled or share unavailable
    }
  }, [copyValue])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el || el.clientWidth === 0) return
    const page = Math.round(el.scrollLeft / el.clientWidth)
    setActiveQrPage(page === 1 ? 'bolt12' : 'unified')
  }, [])

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
    if (needsAmount) {
      // Stay on numpad — amount is required
      setEditingAmount(true)
    } else {
      setEditingAmount(false)
      requestAnimationFrame(() => amountButtonRef.current?.focus())
    }
  }, [needsAmount])

  const handleEditAmount = useCallback(() => {
    setAmountDigits(confirmedAmountDigits)
    setEditingAmount(true)
  }, [confirmedAmountDigits])

  if (
    onchain.status === 'loading' ||
    ldk.status === 'loading' ||
    (!peersReconnected && listChannels && listChannels().length > 0)
  ) {
    return (
      <div className="fixed inset-0 z-200 mx-auto flex max-w-[430px] flex-col bg-dark text-on-dark">
        <ScreenHeader title="Request" backTo="/" />
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        </div>
      </div>
    )
  }

  if (onchain.status === 'error') {
    return (
      <div className="fixed inset-0 z-200 mx-auto flex max-w-[430px] flex-col items-center justify-center bg-dark px-6">
        <p className="text-lg font-semibold text-on-dark">Failed to load wallet</p>
        <p className="mt-2 text-sm text-red-400">{onchain.error.message}</p>
        <button className="mt-6 text-sm text-accent" onClick={() => void navigate('/')}>
          Close
        </button>
      </div>
    )
  }

  // Success screen
  if (receiveState.step === 'success') {
    return (
      <div
        ref={overlayRef}
        className="fixed inset-0 z-200 mx-auto flex max-w-[430px] flex-col bg-dark text-on-dark"
      >
        <ScreenHeader title="Request" backTo="/" />
        <div className="flex flex-1 flex-col items-center justify-center gap-6 px-8">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-green-500/20">
            <svg
              className="h-10 w-10 text-green-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <p className="text-lg font-semibold text-on-dark">Payment received</p>
          <p className="font-display text-4xl font-bold text-on-dark">
            {formatBtc(receiveState.amountSats)}
          </p>
          <button
            className="mt-4 rounded-xl bg-accent px-8 py-3 text-sm font-semibold text-white transition-transform active:scale-95"
            onClick={() => void navigate('/')}
          >
            Done
          </button>
        </div>
      </div>
    )
  }

  // QR uses uppercase for optimal alphanumeric QR encoding
  const qrValue = bip321Uri.toUpperCase()

  const showHeaderCopy = !!address && !editingAmount

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-200 mx-auto flex max-w-[430px] flex-col bg-dark text-on-dark"
    >
      <ScreenHeader
        title="Request"
        backTo="/"
        rightAction={
          showHeaderCopy ? (
            <button
              className="flex h-11 w-11 items-center justify-center rounded-full transition-colors hover:bg-white/10"
              onClick={() => setShowSheet(true)}
              aria-label="Copy payment request"
            >
              <CopyIcon />
            </button>
          ) : undefined
        }
      />

      {receiveState.step === 'negotiating-jit' ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        </div>
      ) : editingAmount ? (
        <div className="flex flex-1 flex-col">
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8">
            {(!needsAmount || confirmedAmountSats > 0n) && (
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
            nextLabel={needsAmount && confirmedAmountSats <= 0n ? 'Request' : 'Done'}
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col">
          <div className="flex flex-1 flex-col items-center justify-center gap-8 px-8">
            {addressError && <p className="text-sm text-red-400">{addressError}</p>}
            {invoiceError && <p className="text-sm text-red-400">{invoiceError}</p>}

            {address && (
              <>
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

                <div className="w-full max-w-[300px]">
                  <div
                    ref={scrollRef}
                    className="flex snap-x snap-mandatory overflow-x-auto scrollbar-none"
                    onScroll={handleScroll}
                  >
                    {/* Page 1: Unified BIP 321 QR */}
                    <div className="flex w-full shrink-0 snap-center justify-center">
                      <div
                        className="flex h-[260px] w-[260px] items-center justify-center rounded-2xl bg-white p-5"
                        aria-label={`QR code for Bitcoin address ${address}${confirmedAmountSats > 0n ? `, amount ${formatBtc(confirmedAmountSats)}` : ''}`}
                      >
                        <QRCodeSVG value={qrValue} size={220} />
                      </div>
                    </div>

                    {/* Page 2: BOLT 12 Offer QR */}
                    {showBolt12 && (
                      <div className="flex w-full shrink-0 snap-center justify-center">
                        <div
                          className="flex h-[260px] w-[260px] items-center justify-center rounded-2xl bg-white p-5"
                          aria-label="QR code for BOLT 12 offer"
                        >
                          <QRCodeSVG value={bolt12Uri.toUpperCase()} size={220} />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Dot indicators */}
                  {showBolt12 && (
                    <div className="mt-4 flex justify-center gap-2" aria-hidden="true">
                      <span
                        className={`h-2 w-2 rounded-full transition-colors ${activeQrPage === 'unified' ? 'bg-white' : 'bg-white/30'}`}
                      />
                      <span
                        className={`h-2 w-2 rounded-full transition-colors ${activeQrPage === 'bolt12' ? 'bg-white' : 'bg-white/30'}`}
                      />
                    </div>
                  )}
                </div>

                {/* Label under QR */}
                <p className="text-xs text-[var(--color-on-dark-muted)]">
                  {activeQrPage === 'bolt12'
                    ? 'Reusable QR code'
                    : openingFeeSats !== null &&
                        receiveState.step === 'ready' &&
                        receiveState.invoicePath === 'jit'
                      ? `Setup fee: ${formatBtc(openingFeeSats)}`
                      : 'Request money by letting someone scan this QR code'}
                </p>
              </>
            )}
          </div>

          {address && (
            <div className="flex flex-col gap-3 px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-4">
              <button
                ref={amountButtonRef}
                className="flex h-14 w-full items-center justify-center rounded-xl bg-dark-elevated text-sm font-semibold text-accent transition-transform active:scale-[0.98]"
                onClick={handleEditAmount}
              >
                {confirmedAmountSats > 0n ? 'Edit amount' : 'Add amount'}
              </button>
              {typeof navigator.share === 'function' && (
                <button
                  className="flex h-14 w-full items-center justify-center rounded-xl bg-dark-elevated text-sm font-semibold text-accent transition-transform active:scale-[0.98]"
                  onClick={() => void handleShare()}
                >
                  Share
                </button>
              )}
            </div>
          )}

          <BottomSheet open={showSheet} onClose={() => setShowSheet(false)}>
            <p className="text-sm font-semibold text-on-dark">
              {activeQrPage === 'bolt12' ? 'Reusable payment request' : 'Payment request'}
            </p>
            <p className="mt-3 select-text break-all font-mono text-xs text-[var(--color-on-dark-muted)]">
              {copyValue}
            </p>
            <button
              className="mt-4 flex h-12 w-full items-center justify-center rounded-xl bg-accent text-sm font-semibold text-white transition-transform active:scale-[0.98]"
              onClick={() => void handleCopy()}
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </BottomSheet>
        </div>
      )}
    </div>
  )
}
