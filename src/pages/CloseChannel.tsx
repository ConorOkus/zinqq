import { useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { useLdk } from '../ldk/use-ldk'
import { bytesToHex } from '../ldk/utils'
import { formatBtc } from '../utils/format-btc'
import { ScreenHeader } from '../components/ScreenHeader'
import { Check, XClose } from '../components/icons'
import type { ChannelId } from 'lightningdevkit'

interface ChannelInfo {
  channelId: ChannelId
  channelIdHex: string
  counterpartyNodeId: Uint8Array
  counterpartyPubkey: string
  capacitySats: bigint
  outboundCapacityMsat: bigint
  inboundCapacityMsat: bigint
  isUsable: boolean
  isReady: boolean
}

type CloseChannelStep =
  | { step: 'select-channel' }
  | { step: 'confirm'; channel: ChannelInfo; closeType: 'cooperative' | 'force' }
  | { step: 'success'; closeType: 'cooperative' | 'force' }
  | { step: 'error'; message: string; canForceClose: boolean; channel: ChannelInfo }

export function CloseChannel() {
  const navigate = useNavigate()
  const ldk = useLdk()
  const [currentStep, setCurrentStep] = useState<CloseChannelStep>({ step: 'select-channel' })
  const [channels, setChannels] = useState<ChannelInfo[]>([])

  const refreshChannels = useCallback(() => {
    if (ldk.status !== 'ready') return
    const list = ldk.listChannels()
    const mapped: ChannelInfo[] = list.map((ch) => {
      const counterparty = ch.get_counterparty()
      return {
        channelId: ch.get_channel_id(),
        channelIdHex: bytesToHex(ch.get_channel_id().write()),
        counterpartyNodeId: counterparty.get_node_id(),
        counterpartyPubkey: bytesToHex(counterparty.get_node_id()),
        capacitySats: ch.get_channel_value_satoshis(),
        outboundCapacityMsat: ch.get_outbound_capacity_msat(),
        inboundCapacityMsat: ch.get_inbound_capacity_msat(),
        isUsable: ch.get_is_usable(),
        isReady: ch.get_is_channel_ready(),
      }
    })
    setChannels(mapped)
  }, [ldk.status]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refreshChannels()
  }, [refreshChannels])

  const handleSelectChannel = useCallback((channel: ChannelInfo) => {
    setCurrentStep({ step: 'confirm', channel, closeType: 'cooperative' })
  }, [])

  const handleConfirm = useCallback(() => {
    if (ldk.status !== 'ready' || currentStep.step !== 'confirm') return

    const { channel, closeType } = currentStep

    try {
      const ok = closeType === 'cooperative'
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
      console.error('[CloseChannel] close error:', err)
      setCurrentStep({
        step: 'error',
        message,
        canForceClose: currentStep.closeType === 'cooperative',
        channel,
      })
    }
  }, [ldk, currentStep])

  // --- Loading / error gates ---
  if (ldk.status === 'loading') {
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
          onClick={() => void navigate('/settings/advanced')}
        >
          Back to Advanced
        </button>
      </div>
    )
  }

  // --- Success screen ---
  if (currentStep.step === 'success') {
    const isForce = currentStep.closeType === 'force'
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-dark px-8 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-accent">
          <Check className="h-10 w-10 text-white" />
        </div>
        <div>
          <div className="font-display text-2xl font-bold text-on-dark">
            Channel Closing
          </div>
          <div className="mt-2 text-sm text-[var(--color-on-dark-muted)]">
            {isForce
              ? 'Force close initiated. Your funds will be available after the timelock expires (may take several hours).'
              : 'Your channel is closing. Funds will return to your wallet once the closing transaction confirms on-chain.'}
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
          <div className="font-display text-2xl font-bold text-on-dark">
            Close Failed
          </div>
          <div className="mt-2 text-sm text-red-400">{currentStep.message}</div>
          <div className="mt-1 text-sm text-[var(--color-on-dark-muted)]">
            Your funds are safe.
          </div>
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
            onClick={() => setCurrentStep({ step: 'select-channel' })}
          >
            Try Again
          </button>
        </div>
      </div>
    )
  }

  // --- Confirm screen ---
  if (currentStep.step === 'confirm') {
    const { channel, closeType } = currentStep
    const localSats = channel.outboundCapacityMsat / 1000n
    const remoteSats = channel.inboundCapacityMsat / 1000n
    const isForce = closeType === 'force'

    return (
      <div className="flex min-h-dvh flex-col justify-between bg-dark text-on-dark">
        <ScreenHeader title="Close Channel" onBack={() => setCurrentStep({ step: 'select-channel' })} />
        <div className="flex flex-1 flex-col gap-6 px-6 pt-8">
          <div className="flex justify-between">
            <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">Peer</span>
            <span className="max-w-[60%] break-all text-right font-mono text-sm font-semibold">
              {channel.counterpartyPubkey.slice(0, 12)}...{channel.counterpartyPubkey.slice(-8)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">Channel Capacity</span>
            <span className="font-semibold">{formatBtc(channel.capacitySats)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">Your Balance</span>
            <span className="font-semibold">{formatBtc(localSats)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">Remote Balance</span>
            <span className="font-semibold">{formatBtc(remoteSats)}</span>
          </div>

          <hr className="border-dark-border" />

          {/* Close type toggle */}
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">Close Method</span>
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

          {isForce && (
            <div className="rounded-lg bg-red-500/10 p-3 text-sm text-red-400">
              Force close broadcasts your latest commitment transaction. Funds will be locked
              for a timelock period (may take several hours) before they can be swept to your wallet.
            </div>
          )}
        </div>

        <div className="px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-4">
          <button
            className={`h-14 w-full rounded-xl font-display text-lg font-bold transition-transform active:scale-[0.98] ${
              isForce
                ? 'bg-red-500 text-white'
                : 'bg-accent text-white'
            }`}
            onClick={handleConfirm}
          >
            {isForce ? 'Force Close Channel' : 'Close Channel'}
          </button>
        </div>
      </div>
    )
  }

  // --- Channel selection screen ---
  return (
    <div className="flex min-h-dvh flex-col bg-dark text-on-dark">
      <ScreenHeader title="Close Channel" backTo="/settings/advanced" />
      <div className="flex flex-col gap-4 px-6 pt-2">
        <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">
          Select a channel to close
        </span>

        {channels.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-[var(--color-on-dark-muted)]">No open channels</p>
            <button
              className="text-sm text-accent"
              onClick={() => void navigate('/settings/advanced/open-channel')}
            >
              Open a Channel
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {channels.map((channel) => {
              const localSats = channel.outboundCapacityMsat / 1000n
              const remoteSats = channel.inboundCapacityMsat / 1000n
              const totalForBar = localSats + remoteSats
              const localPercent = totalForBar > 0n
                ? Number((localSats * 100n) / totalForBar)
                : 50

              return (
                <div
                  key={channel.channelIdHex}
                  className="flex flex-col gap-3 rounded-xl bg-dark-elevated p-4"
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        channel.isUsable
                          ? 'bg-green-500/20 text-green-400'
                          : channel.isReady
                            ? 'bg-yellow-500/20 text-yellow-400'
                            : 'bg-[var(--color-on-dark-muted)]/20 text-[var(--color-on-dark-muted)]'
                      }`}
                    >
                      {channel.isUsable ? 'Open' : channel.isReady ? 'Ready' : 'Pending'}
                    </span>
                    <span className="font-semibold">{formatBtc(channel.capacitySats)}</span>
                  </div>

                  <span className="font-mono text-xs text-[var(--color-on-dark-muted)]">
                    {channel.counterpartyPubkey.slice(0, 12)}...{channel.counterpartyPubkey.slice(-8)}
                  </span>

                  {/* Balance bar */}
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${localPercent}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-[var(--color-on-dark-muted)]">
                    <span>Local: {formatBtc(localSats)}</span>
                    <span>Remote: {formatBtc(remoteSats)}</span>
                  </div>

                  <button
                    className="h-10 w-full rounded-lg border border-red-500/50 text-sm font-semibold text-red-400 transition-colors active:bg-red-500/10"
                    onClick={() => handleSelectChannel(channel)}
                  >
                    Close Channel
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
