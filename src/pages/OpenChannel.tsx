import { useState, useCallback, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router'
import { useLdk } from '../ldk/use-ldk'
import { useOnchain } from '../onchain/use-onchain'
import { hexToBytes, bytesToHex } from '../ldk/utils'
import { formatBtc } from '../utils/format-btc'
import { getFeeRate } from '../shared/fee-cache'
import { ScreenHeader } from '../components/ScreenHeader'
import { Numpad, type NumpadKey } from '../components/Numpad'
import { numpadDigitReducer } from '../components/numpad-reducer'
import { Check, XClose } from '../components/icons'
import { captureError } from '../storage/error-log'

const PUBKEY_HEX_RE = /^[0-9a-f]{66}$/

interface OpenChannelState {
  peerPubkey?: string
  peerHost?: string
  peerPort?: number
}

type OpenChannelStep =
  | { step: 'amount' }
  | { step: 'reviewing'; amountSats: bigint; estimatedFeeSats: bigint; feeRate: bigint }
  | { step: 'opening'; amountSats: bigint }
  | { step: 'success' }
  | { step: 'error'; message: string }

const MIN_CHANNEL_SATS = 20_000n
// LDK protocol limit for non-wumbo channels
const MAX_CHANNEL_SATS = 16_777_215n
const MAX_DIGITS = 8
// Approximate funding tx vsize: 1-input P2TR → ~140 vB
const APPROX_FUNDING_TX_VBYTES = 140n

export function OpenChannel() {
  const navigate = useNavigate()
  const location = useLocation()
  const ldk = useLdk()
  const onchain = useOnchain()

  const routeState = (location.state ?? {}) as OpenChannelState
  const peerPubkey =
    typeof routeState.peerPubkey === 'string' && PUBKEY_HEX_RE.test(routeState.peerPubkey)
      ? routeState.peerPubkey
      : undefined
  const peerHost = typeof routeState.peerHost === 'string' ? routeState.peerHost : undefined
  const peerPort = typeof routeState.peerPort === 'number' ? routeState.peerPort : undefined
  const needsConnect = Boolean(peerHost && peerPort)

  const [currentStep, setCurrentStep] = useState<OpenChannelStep>({ step: 'amount' })
  const [amountDigits, setAmountDigits] = useState('')
  const [amountError, setAmountError] = useState<string | null>(null)
  const [feeRate, setFeeRate] = useState<bigint | null>(null)
  const openingRef = useRef(false)

  // Redirect to Peers if no peer pubkey in route state
  useEffect(() => {
    if (!peerPubkey) {
      void navigate('/settings/advanced/peers', { replace: true })
    }
  }, [peerPubkey, navigate])

  const balance =
    onchain.status === 'ready' ? onchain.balance.confirmed + onchain.balance.trustedPending : 0n

  // Fetch fee rate from shared cache
  useEffect(() => {
    void getFeeRate(6)
      .then((satPerVb) => setFeeRate(BigInt(Math.ceil(satPerVb))))
      .catch(() => setFeeRate(1n))
  }, [])

  // --- Numpad handler ---
  const handleNumpadKey = useCallback((key: NumpadKey) => {
    setAmountError(null)
    setAmountDigits((prev) => numpadDigitReducer(prev, key, MAX_DIGITS))
  }, [])

  const amountSats = amountDigits ? BigInt(amountDigits) : 0n

  // --- Amount next (go to review) ---
  const handleAmountNext = useCallback(() => {
    if (currentStep.step !== 'amount') return
    setAmountError(null)

    if (amountSats < MIN_CHANNEL_SATS) {
      setAmountError(`Minimum channel size is ${formatBtc(MIN_CHANNEL_SATS)}`)
      return
    }

    if (amountSats > MAX_CHANNEL_SATS) {
      setAmountError(`Maximum channel size is ${formatBtc(MAX_CHANNEL_SATS)}`)
      return
    }

    const rate = feeRate ?? 1n
    const estimatedFee = rate * APPROX_FUNDING_TX_VBYTES

    if (amountSats + estimatedFee > balance) {
      setAmountError('Amount plus fees exceeds available balance')
      return
    }

    setCurrentStep({
      step: 'reviewing',
      amountSats,
      estimatedFeeSats: estimatedFee,
      feeRate: rate,
    })
  }, [currentStep, amountSats, balance, feeRate])

  // --- Confirm: connect (if needed) then open channel ---
  const handleConfirm = useCallback(async () => {
    if (openingRef.current) return
    if (ldk.status !== 'ready' || currentStep.step !== 'reviewing' || !peerPubkey) return

    openingRef.current = true
    const channelAmountSats = currentStep.amountSats
    setCurrentStep({ step: 'opening', amountSats: channelAmountSats })

    try {
      // Connect to peer first if we have host/port and aren't already connected
      if (needsConnect && peerHost && peerPort) {
        const alreadyConnected = ldk.node.peerManager
          .list_peers()
          .some((p) => bytesToHex(p.get_counterparty_node_id()) === peerPubkey)
        if (!alreadyConnected) {
          await ldk.connectToPeer(peerPubkey, peerHost, peerPort)
        }
      }

      const pubkeyBytes = hexToBytes(peerPubkey)
      const ok = ldk.createChannel(pubkeyBytes, channelAmountSats)
      if (ok) {
        setCurrentStep({ step: 'success' })
      } else {
        setCurrentStep({
          step: 'error',
          message: 'Failed to initiate channel opening. The peer may have disconnected.',
        })
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      captureError('error', 'OpenChannel', 'Channel open error', String(err))
      setCurrentStep({ step: 'error', message })
    } finally {
      openingRef.current = false
    }
  }, [ldk, currentStep, peerPubkey, needsConnect, peerHost, peerPort])

  // --- Guard: no peer pubkey ---
  if (!peerPubkey) return null

  // --- Loading / error gates ---
  if (ldk.status === 'loading' || onchain.status === 'loading') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-dark">
        <p className="text-[var(--color-on-dark-muted)]">Loading...</p>
      </div>
    )
  }

  const gatewayError =
    ldk.status === 'error'
      ? { title: 'Lightning node error', msg: ldk.error.message }
      : onchain.status === 'error'
        ? { title: 'Wallet error', msg: onchain.error.message }
        : null

  if (gatewayError) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-dark px-6">
        <p className="text-lg font-semibold text-on-dark">{gatewayError.title}</p>
        <p className="mt-2 text-sm text-red-400">{gatewayError.msg}</p>
        <button
          className="mt-6 text-sm text-accent"
          onClick={() => void navigate('/settings/advanced/peers')}
        >
          Back to Peers
        </button>
      </div>
    )
  }

  // --- Opening screen (connecting + opening) ---
  if (currentStep.step === 'opening') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-dark px-8 text-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-accent border-t-transparent" />
        <div className="text-sm text-[var(--color-on-dark-muted)]">
          {needsConnect ? 'Connecting to peer & opening channel...' : 'Opening channel...'}
        </div>
      </div>
    )
  }

  // --- Success screen ---
  if (currentStep.step === 'success') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-dark px-8 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-accent">
          <Check className="h-10 w-10 text-white" />
        </div>
        <div>
          <div className="font-display text-2xl font-bold text-on-dark">Channel Opening</div>
          <div className="mt-2 text-sm text-[var(--color-on-dark-muted)]">
            Your channel is being set up. It will be ready once the funding transaction confirms
            on-chain.
          </div>
        </div>
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
  if (currentStep.step === 'error') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-dark px-8 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-red-500/20">
          <XClose className="h-10 w-10 text-red-400" />
        </div>
        <div>
          <div className="font-display text-2xl font-bold text-on-dark">Channel Open Failed</div>
          <div className="mt-2 text-sm text-red-400">{currentStep.message}</div>
          <div className="mt-1 text-sm text-[var(--color-on-dark-muted)]">Your funds are safe.</div>
        </div>
        <button
          className="mt-4 h-14 w-full max-w-[280px] rounded-xl bg-white font-display text-lg font-bold text-dark transition-transform active:scale-[0.98]"
          onClick={() => setCurrentStep({ step: 'amount' })}
        >
          Try Again
        </button>
      </div>
    )
  }

  // --- Review screen ---
  if (currentStep.step === 'reviewing') {
    return (
      <div className="flex min-h-dvh flex-col justify-between bg-dark text-on-dark">
        <ScreenHeader title="Review" onBack={() => setCurrentStep({ step: 'amount' })} />
        <div className="flex flex-1 flex-col gap-6 px-6 pt-8">
          <div className="flex justify-between">
            <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">Peer</span>
            <span className="max-w-[60%] break-all text-right font-mono text-sm font-semibold">
              {peerPubkey.slice(0, 12)}...{peerPubkey.slice(-8)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">
              Channel Size
            </span>
            <span className="font-semibold">{formatBtc(currentStep.amountSats)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">
              Est. fee (~{currentStep.feeRate.toString()} sat/vB)
            </span>
            <span className="font-semibold">≈ {formatBtc(currentStep.estimatedFeeSats)}</span>
          </div>
          <hr className="border-dark-border" />
          <div className="flex justify-between">
            <span className="text-lg font-semibold">Total</span>
            <span className="font-display text-3xl font-bold">
              ≈ {formatBtc(currentStep.amountSats + currentStep.estimatedFeeSats)}
            </span>
          </div>
        </div>
        <div className="px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-4">
          <button
            className="h-14 w-full rounded-xl bg-accent font-display text-lg font-bold text-white transition-transform active:scale-[0.98]"
            onClick={() => void handleConfirm()}
          >
            {needsConnect ? 'Connect & Open Channel' : 'Open Channel'}
          </button>
        </div>
      </div>
    )
  }

  // --- Amount screen (numpad) — first step ---
  return (
    <div className="flex min-h-dvh flex-col justify-between bg-dark text-on-dark">
      <ScreenHeader title="Channel Size" backTo="/settings/advanced/peers" />
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <span className="text-sm text-[var(--color-on-dark-muted)]">
          {formatBtc(balance)} available
        </span>
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
      <Numpad onKey={handleNumpadKey} onNext={handleAmountNext} nextDisabled={amountSats <= 0n} />
    </div>
  )
}
