import { useState, useCallback, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router'
import {
  Option_ChannelShutdownStateZ_Some,
  Option_u64Z_Some,
  ChannelShutdownState,
} from 'lightningdevkit'
import { useLdk } from '../ldk/use-ldk'
import { bytesToHex } from '../ldk/utils'
import { formatBtc } from '../utils/format-btc'
import { ScreenHeader } from '../components/ScreenHeader'
import { Check, XClose } from '../components/icons'
import type { ChannelInfoWithId } from '../ldk/types'
import { humanizeBlocks, type CloseEstimate } from '../ldk/close-records/estimate'
import { captureError } from '../storage/error-log'

const PUBKEY_HEX_RE = /^[0-9a-f]{66}$/
const HEX_RE = /^[0-9a-f]+$/

interface RouteState {
  channelIdHex?: string
  counterpartyPubkey?: string
  /** Preselect force close (used for channels stuck in a stalled cooperative close). */
  closeType?: string
}

type CloseChannelStep =
  | { step: 'confirm'; channel: ChannelInfoWithId; closeType: 'cooperative' | 'force' }
  | { step: 'success'; closeType: 'cooperative' | 'force' }
  | { step: 'error'; message: string; canForceClose: boolean; channel: ChannelInfoWithId }

export function CloseChannel() {
  const navigate = useNavigate()
  const location = useLocation()
  const ldk = useLdk()

  const routeState = (location.state ?? {}) as RouteState
  const channelIdHex =
    typeof routeState.channelIdHex === 'string' && HEX_RE.test(routeState.channelIdHex)
      ? routeState.channelIdHex
      : undefined
  const counterpartyPubkey =
    typeof routeState.counterpartyPubkey === 'string' &&
    PUBKEY_HEX_RE.test(routeState.counterpartyPubkey)
      ? routeState.counterpartyPubkey
      : undefined
  const initialCloseType = routeState.closeType === 'force' ? 'force' : 'cooperative'

  const [currentStep, setCurrentStep] = useState<CloseChannelStep | null>(null)
  const [isClosing, setIsClosing] = useState(false)
  // Pre-close estimate. Purely informational: fetch failure leaves it null
  // and the screen renders placeholders — closing must never be blocked.
  const [estimate, setEstimate] = useState<CloseEstimate | null>(null)
  const [estimateLoading, setEstimateLoading] = useState(true)
  const closingRef = useRef(false)

  // Redirect if missing route state
  useEffect(() => {
    if (!channelIdHex || !counterpartyPubkey) {
      void navigate('/settings/advanced/peers', { replace: true })
    }
  }, [channelIdHex, counterpartyPubkey, navigate])

  // Look up the channel from LDK once ready
  useEffect(() => {
    if (ldk.status !== 'ready' || !channelIdHex || !counterpartyPubkey) return
    if (currentStep !== null) return // Already initialized

    const channels = ldk.listChannels()
    const match = channels.find((ch) => bytesToHex(ch.get_channel_id().write()) === channelIdHex)

    if (!match) {
      void navigate('/settings/advanced/peers', { replace: true })
      return
    }

    const counterparty = match.get_counterparty()
    const shutdownState = match.get_channel_shutdown_state()
    const reserve = match.get_unspendable_punishment_reserve()
    const channel: ChannelInfoWithId = {
      channelId: match.get_channel_id(),
      channelIdHex,
      counterpartyNodeId: new Uint8Array(counterparty.get_node_id()),
      counterpartyPubkey: bytesToHex(counterparty.get_node_id()),
      capacitySats: match.get_channel_value_satoshis(),
      outboundCapacityMsat: match.get_outbound_capacity_msat(),
      inboundCapacityMsat: match.get_inbound_capacity_msat(),
      isUsable: match.get_is_usable(),
      isReady: match.get_is_channel_ready(),
      reserveSats: reserve instanceof Option_u64Z_Some ? reserve.some : null,
      isShuttingDown:
        shutdownState instanceof Option_ChannelShutdownStateZ_Some &&
        shutdownState.some !== ChannelShutdownState.LDKChannelShutdownState_NotShuttingDown,
    }

    setCurrentStep({ step: 'confirm', channel, closeType: initialCloseType })
  }, [ldk.status, channelIdHex, counterpartyPubkey, initialCloseType, navigate]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the pre-close estimate once the node is ready. Best-effort only.
  // Granular dep: the context value changes identity on every balance tick,
  // but estimateClose is a stable callback — depend on it, not on `ldk`.
  const estimateCloseFn = ldk.status === 'ready' ? ldk.estimateClose : null
  useEffect(() => {
    if (!estimateCloseFn || !channelIdHex) return
    let cancelled = false
    estimateCloseFn(channelIdHex)
      .then((result) => {
        if (!cancelled) setEstimate(result)
      })
      .catch(() => {
        // estimateClose never throws by contract; belt-and-suspenders only
      })
      .finally(() => {
        if (!cancelled) setEstimateLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [estimateCloseFn, channelIdHex])

  const handleConfirm = useCallback(() => {
    if (closingRef.current) return
    if (ldk.status !== 'ready' || !currentStep || currentStep.step !== 'confirm') return

    closingRef.current = true
    setIsClosing(true)
    const { channel, closeType } = currentStep

    try {
      const ok =
        closeType === 'cooperative'
          ? ldk.closeChannel(channel.channelId, channel.counterpartyNodeId)
          : ldk.forceCloseChannel(channel.channelId, channel.counterpartyNodeId)

      if (ok) {
        setCurrentStep({ step: 'success', closeType })
      } else {
        const isCoop = closeType === 'cooperative'
        setCurrentStep({
          step: 'error',
          message: isCoop
            ? 'Cooperative close failed. The peer may be disconnected or the channel has pending payments.'
            : 'Force close failed.',
          canForceClose: isCoop,
          channel,
        })
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      captureError('error', 'CloseChannel', 'Close error', String(err))
      setCurrentStep({
        step: 'error',
        message,
        canForceClose: currentStep.closeType === 'cooperative',
        channel: currentStep.channel,
      })
    } finally {
      closingRef.current = false
      setIsClosing(false)
    }
  }, [ldk, currentStep])

  // --- Guard: no route state ---
  if (!channelIdHex || !counterpartyPubkey) return null

  // --- Loading ---
  if (ldk.status === 'loading' || !currentStep) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-dark">
        <p className="text-[var(--color-on-dark-muted)]">Loading...</p>
      </div>
    )
  }

  if (ldk.status === 'error') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-dark px-6">
        <p className="text-lg font-semibold text-on-dark">Lightning node error</p>
        <p className="mt-2 text-sm text-red-400">{ldk.error.message}</p>
        <button
          className="mt-6 text-sm text-accent"
          onClick={() => void navigate('/settings/advanced/peers')}
        >
          Back to Peers
        </button>
      </div>
    )
  }

  // --- Success screen ---
  if (currentStep.step === 'success') {
    const isForce = currentStep.closeType === 'force'
    const forceTimeline =
      estimate?.timelockBlocks != null ? humanizeBlocks(estimate.timelockBlocks) : '~14 days'
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-dark px-8 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-accent">
          <Check className="h-10 w-10 text-white" />
        </div>
        <div>
          <div className="font-display text-2xl font-bold text-on-dark">Channel Closing</div>
          <div className="mt-2 text-sm text-[var(--color-on-dark-muted)]">
            {isForce
              ? `Force close initiated. Your funds will be accessible in ${forceTimeline} — they return to your wallet automatically once the timelock expires.`
              : 'Your channel is closing. Funds return to your wallet once the closing transaction confirms on-chain — keep the app open until the close completes.'}
          </div>
        </div>
        <div className="flex w-full max-w-[280px] flex-col gap-3">
          <button
            className="mt-4 h-14 w-full rounded-xl bg-white font-display text-lg font-bold text-dark transition-transform active:scale-[0.98]"
            onClick={() => void navigate(`/activity/close/${channelIdHex}`)}
          >
            Track Progress
          </button>
          <button
            className="h-14 w-full rounded-xl border-2 border-white/20 font-display text-lg font-bold text-on-dark transition-transform active:scale-[0.98]"
            onClick={() => void navigate('/')}
          >
            Done
          </button>
        </div>
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
          <div className="font-display text-2xl font-bold text-on-dark">Close Failed</div>
          <div className="mt-2 text-sm text-red-400">{currentStep.message}</div>
          <div className="mt-1 text-sm text-[var(--color-on-dark-muted)]">Your funds are safe.</div>
        </div>
        <div className="flex w-full max-w-[280px] flex-col gap-3">
          {currentStep.canForceClose && (
            <button
              className="h-14 w-full rounded-xl border-2 border-red-500 font-display text-lg font-bold text-red-400 transition-transform active:scale-[0.98]"
              onClick={() =>
                setCurrentStep({
                  step: 'confirm',
                  channel: currentStep.channel,
                  closeType: 'force',
                })
              }
            >
              Force Close Instead
            </button>
          )}
          <button
            className="h-14 w-full rounded-xl bg-white font-display text-lg font-bold text-dark transition-transform active:scale-[0.98]"
            onClick={() =>
              setCurrentStep({
                step: 'confirm',
                channel: currentStep.channel,
                closeType: 'cooperative',
              })
            }
          >
            Try Again
          </button>
        </div>
      </div>
    )
  }

  // --- Confirm screen --- (first step now)
  const { channel, closeType } = currentStep
  const localSats = channel.outboundCapacityMsat / 1000n
  const remoteSats = channel.inboundCapacityMsat / 1000n
  const isForce = closeType === 'force'

  const costSats = isForce ? estimate?.forceTotalYouPaySats : estimate?.coopTotalYouPaySats
  const costLabel = estimateLoading
    ? 'Estimating…'
    : costSats != null
      ? `~${formatBtc(costSats)}`
      : 'Estimate unavailable'
  const timelineLabel = isForce
    ? estimate?.timelockBlocks != null
      ? `up to ${humanizeBlocks(estimate.timelockBlocks)}`
      : 'up to ~14 days'
    : '~minutes once confirmed'
  const expectedBackLabel = estimateLoading
    ? 'Estimating…'
    : estimate?.expectedBackSats != null
      ? `~${formatBtc(estimate.expectedBackSats)}`
      : '—'
  const lspPaysCloseFee = !isForce && estimate?.feePayer === 'counterparty'
  const pendingHtlcs = estimate?.pendingHtlcCount ?? 0

  return (
    <div className="flex min-h-dvh flex-col justify-between bg-dark text-on-dark">
      <ScreenHeader title="Close Channel" backTo="/settings/advanced/peers" />
      <div className="flex flex-1 flex-col gap-6 px-6 pt-8">
        <div className="flex justify-between">
          <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">Peer</span>
          <span className="max-w-[60%] break-all text-right font-mono text-sm font-semibold">
            {channel.counterpartyPubkey.slice(0, 12)}...{channel.counterpartyPubkey.slice(-8)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">
            Channel Capacity
          </span>
          <span className="font-semibold">{formatBtc(channel.capacitySats)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">
            Your Balance
          </span>
          <span className="font-semibold">{formatBtc(localSats)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">
            Remote Balance
          </span>
          <span className="font-semibold">{formatBtc(remoteSats)}</span>
        </div>

        <hr className="border-dark-border" />

        <div className="flex justify-between">
          <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">
            You Get Back
          </span>
          <span className="font-semibold">{expectedBackLabel}</span>
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex justify-between">
            <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">
              Estimated Cost to You
            </span>
            <span className="font-semibold">{costLabel}</span>
          </div>
          {lspPaysCloseFee && (
            <span className="text-xs text-[var(--color-on-dark-muted)]">
              The closing fee is paid by the LSP — this close costs you nothing.
            </span>
          )}
          <span className="text-xs text-[var(--color-on-dark-muted)]">
            Estimate at current network fees; the final cost varies with network conditions.
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">
            Funds Available
          </span>
          <span className="font-semibold">{timelineLabel}</span>
        </div>

        <hr className="border-dark-border" />

        {/* Close type toggle */}
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">
            Close Method
          </span>
          <div className="flex gap-2">
            <button
              className={`flex-1 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors ${
                !isForce
                  ? 'bg-accent text-white'
                  : 'bg-dark-elevated text-[var(--color-on-dark-muted)]'
              }`}
              onClick={() => setCurrentStep({ ...currentStep, closeType: 'cooperative' })}
            >
              Cooperative
            </button>
            <button
              className={`flex-1 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors ${
                isForce
                  ? 'bg-red-500/20 text-red-400'
                  : 'bg-dark-elevated text-[var(--color-on-dark-muted)]'
              }`}
              onClick={() => setCurrentStep({ ...currentStep, closeType: 'force' })}
            >
              Force Close
            </button>
          </div>
        </div>

        {isForce ? (
          <div className="rounded-lg bg-red-500/10 p-3 text-sm text-red-400">
            Force closing moves your balance on-chain without the LSP&apos;s cooperation. It may
            cost more, and your funds are locked for {timelineLabel} while the network verifies the
            close. You wait; the other side doesn&apos;t.
          </div>
        ) : (
          <div className="rounded-lg bg-dark-elevated p-3 text-sm text-[var(--color-on-dark-muted)]">
            Closing this channel moves your balance back to your on-chain wallet and incurs an
            on-chain fee. The LSP must be online — keep the app open until the close completes.
          </div>
        )}

        {isForce && estimate?.isAnchor === false && (
          <div className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-400">
            This channel doesn&apos;t support anchor outputs, so the force-close transaction
            can&apos;t be fee-bumped. If network fees spike, confirmation may take much longer.
          </div>
        )}

        {pendingHtlcs > 0 && (
          <div className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-400">
            {pendingHtlcs === 1
              ? '1 in-flight payment'
              : `${String(pendingHtlcs)} in-flight payments`}{' '}
            must settle before the close completes — the amount returned may change.
          </div>
        )}
      </div>

      <div className="px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-4">
        <button
          className={`h-14 w-full rounded-xl font-display text-lg font-bold transition-transform active:scale-[0.98] disabled:opacity-30 ${
            isForce ? 'bg-red-500 text-white' : 'bg-accent text-white'
          }`}
          onClick={handleConfirm}
          disabled={isClosing}
        >
          {isClosing ? 'Closing…' : isForce ? 'Force Close Channel' : 'Close Channel'}
        </button>
      </div>
    </div>
  )
}
