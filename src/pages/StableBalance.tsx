import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { QRCodeSVG } from 'qrcode.react'
import { ScreenHeader } from '../components/ScreenHeader'
import { useStableBalance } from '../stable/use-stable-balance'
import { getStableRuntime } from '../stable/runtime'
import { formatUsd, parseUsd } from '../stable/math'
import type { StableTradeQuote } from '../stable/types'
import type { JitQuote } from '../ldk/context'
import type { JitInvoiceResult } from '../ldk/lsps2/types'
import { formatBtc } from '../utils/format-btc'

const BUTTON =
  'min-h-12 w-full rounded-xl bg-accent px-4 py-3 font-semibold text-dark disabled:opacity-40'
const INPUT =
  'mt-2 min-h-12 w-full rounded-xl border border-on-dark/20 bg-dark-elevated px-4 text-on-dark'

export function StableBalance() {
  const snapshot = useStableBalance()
  const runtime = getStableRuntime()
  const navigate = useNavigate()
  const [target, setTarget] = useState('')
  const [fundingSats, setFundingSats] = useState('')
  const [tradeQuote, setTradeQuote] = useState<StableTradeQuote | null>(null)
  const [fundingQuote, setFundingQuote] = useState<JitQuote | null>(null)
  const [invoice, setInvoice] = useState<JitInvoiceResult | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const position = snapshot.state?.position
  const positionClosed = !!position && snapshot.channel?.channelId !== position.channelId
  const busy = working || snapshot.busy
  const fresh = snapshot.priceFresh
  const backing = BigInt(position?.backingSats ?? '0')
  const native = snapshot.channel ? snapshot.channel.receiverSats - backing : 0n

  useEffect(() => {
    if (runtime) void runtime.client.refresh().catch(() => {})
  }, [runtime])

  async function perform(action: () => Promise<void>) {
    setWorking(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to complete this action')
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-dark text-on-dark">
      <ScreenHeader title="Stable Balance" backTo="/settings" />
      <div className="mx-auto flex w-full max-w-lg flex-col gap-5 px-6 pb-12 pt-4">
        <p className="text-sm text-[var(--color-on-dark-muted)]">
          Keep part of your Lightning bitcoin at a USD target through automatic payments with a
          stability provider. On-chain funds and your other bitcoin remain exposed to the bitcoin
          price.
        </p>
        <section className="rounded-2xl bg-dark-elevated p-5" aria-label="Stable balance status">
          <p className="text-sm text-[var(--color-on-dark-muted)]">Acknowledged USD target</p>
          <p className="mt-1 font-display text-4xl font-bold">
            {position ? formatUsd(BigInt(Math.round(position.targetUsd * 100))) : 'Not allocated'}
          </p>
          <p className="mt-3 text-sm" role="status">
            {snapshot.status}
          </p>
          {position && (
            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <dt>Bitcoin backing</dt>
                <dd>{formatBtc(backing)}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt>Current backing value</dt>
                <dd>
                  {!positionClosed && fresh && snapshot.price
                    ? formatUsd((backing * snapshot.price.priceCents) / 100_000_000n)
                    : 'Price unavailable'}
                </dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt>Native BTC in this channel</dt>
                <dd>{native >= 0n ? formatBtc(native) : 'Reconciliation pending'}</dd>
              </div>
            </dl>
          )}
        </section>

        {(error || snapshot.error) && (
          <p role="alert" className="rounded-xl bg-danger/10 p-4 text-sm text-danger">
            {error ?? snapshot.error}
          </p>
        )}
        {!runtime ? (
          <p className="text-sm">
            Waiting for the wallet and its encrypted backup.{' '}
            {snapshot.error ? 'Refresh the wallet after resolving the error.' : ''}
          </p>
        ) : (
          <>
            <section className="rounded-2xl border border-on-dark/15 p-4">
              <h2 className="font-semibold">Stability provider</h2>
              <p className="mt-2 text-sm">
                {runtime.provider.host}:{runtime.provider.port}
              </p>
              <p className="mt-1 break-all font-mono text-xs text-[var(--color-on-dark-muted)]">
                {runtime.provider.nodeId}
              </p>
              {!snapshot.state?.enabled && (
                <button
                  className={`${BUTTON} mt-4`}
                  disabled={busy}
                  onClick={() => void perform(runtime.enable)}
                >
                  Use this provider
                </button>
              )}
            </section>

            {snapshot.state?.enabled && (
              <>
                {positionClosed && (
                  <section className="space-y-3 rounded-2xl bg-dark-elevated p-4">
                    <p className="text-sm">
                      The previous provider channel is closed. Its USD target no longer settles; any
                      channel proceeds are bitcoin.
                    </p>
                    <button
                      className={BUTTON}
                      disabled={busy || !!snapshot.state.pending || snapshot.state.inbox.length > 0}
                      onClick={() => void perform(runtime.client.clearClosedPosition)}
                    >
                      Clear closed position
                    </button>
                  </section>
                )}
                {!snapshot.channel &&
                  snapshot.status === 'Fund a channel with the stability provider' && (
                    <section className="space-y-3" aria-label="Fund provider channel">
                      <h2 className="font-semibold">Fund your provider channel</h2>
                      <p className="text-sm text-[var(--color-on-dark-muted)]">
                        Pay a Lightning invoice from another wallet. The provider opens a channel
                        and supplies its side of the collateral.
                      </p>
                      <label className="block text-sm">
                        Funding amount in sats
                        <input
                          className={INPUT}
                          inputMode="numeric"
                          value={fundingSats}
                          onChange={(event) => {
                            setFundingSats(event.target.value)
                            setFundingQuote(null)
                            setInvoice(null)
                          }}
                        />
                      </label>
                      <button
                        className={BUTTON}
                        disabled={busy || !!fundingQuote}
                        onClick={() =>
                          void perform(async () => {
                            if (!/^\d{1,12}$/.test(fundingSats) || BigInt(fundingSats) <= 0n)
                              throw new Error('Enter a positive funding amount in sats')
                            setFundingQuote(await runtime.quoteFunding(BigInt(fundingSats)))
                          })
                        }
                      >
                        Review funding invoice
                      </button>
                    </section>
                  )}
                {fundingQuote && !invoice && (
                  <section
                    className="space-y-3 rounded-2xl bg-dark-elevated p-4"
                    aria-label="Funding review"
                  >
                    <p>Invoice amount: {formatBtc(fundingQuote.amountMsat / 1000n)}</p>
                    <p>
                      Channel opening fee: {formatBtc((fundingQuote.openingFeeMsat + 999n) / 1000n)}
                    </p>
                    <p className="text-sm">
                      Only confirm if you want this provider to reserve channel liquidity.
                    </p>
                    <button
                      className={BUTTON}
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          setInvoice(await runtime.confirmFunding(fundingQuote))
                        })
                      }
                    >
                      Create funding invoice
                    </button>
                    <button
                      className="min-h-11 w-full text-sm underline"
                      onClick={() => setFundingQuote(null)}
                      disabled={busy}
                    >
                      Cancel funding
                    </button>
                  </section>
                )}
                {invoice && (
                  <section
                    className="space-y-3 rounded-2xl bg-dark-elevated p-4"
                    aria-label="Funding invoice"
                  >
                    <div className="mx-auto w-fit rounded-xl bg-white p-3">
                      <QRCodeSVG value={invoice.bolt11} size={200} />
                    </div>
                    <p className="text-sm">
                      Expires {new Date(invoice.expiresAtMs).toLocaleTimeString()}. Allocation
                      starts after the channel is ready.
                    </p>
                    <textarea
                      aria-label="Lightning funding invoice"
                      className="w-full break-all rounded-lg bg-dark p-3 font-mono text-xs"
                      readOnly
                      value={invoice.bolt11}
                      rows={4}
                    />
                    <button
                      className="min-h-11 w-full text-sm underline"
                      onClick={() =>
                        void perform(async () => {
                          await navigator.clipboard.writeText(invoice.bolt11)
                        })
                      }
                    >
                      Copy invoice
                    </button>
                  </section>
                )}

                {snapshot.channel && (
                  <section className="space-y-3" aria-label="Allocate USD">
                    <h2 className="font-semibold">Set your USD target</h2>
                    <p className="text-sm text-[var(--color-on-dark-muted)]">
                      Changing your target costs a 1% trade fee. Keep a small native BTC reserve.
                      Enter 0 to return the position to BTC after its last settlement.
                    </p>
                    <label className="block text-sm">
                      USD target
                      <input
                        className={INPUT}
                        inputMode="decimal"
                        placeholder="100.00"
                        value={target}
                        onChange={(event) => {
                          setTarget(event.target.value)
                          setTradeQuote(null)
                        }}
                      />
                    </label>
                    <button
                      className={BUTTON}
                      disabled={busy || !!snapshot.state.pending || !snapshot.channel.usable}
                      onClick={() =>
                        void perform(async () => {
                          await runtime.client.refresh()
                          setTradeQuote(runtime.client.quote(parseUsd(target)))
                        })
                      }
                    >
                      Review USD target
                    </button>
                  </section>
                )}
                {tradeQuote && (
                  <section
                    className="space-y-3 rounded-2xl bg-dark-elevated p-4"
                    aria-label="Trade review"
                  >
                    <p>New USD target: {formatUsd(tradeQuote.targetCents)}</p>
                    <p>
                      Trade fee: {formatBtc(tradeQuote.feeSats)}
                      {tradeQuote.feeSats === 0n ? ' (1 millisatoshi minimum)' : ''}
                    </p>
                    <p>BTC/USD quote: {formatUsd(tradeQuote.price.priceCents)}</p>
                    <p className="text-sm">
                      The target changes only after the provider signs its acceptance. No automatic
                      retry if the result is uncertain.
                    </p>
                    <button
                      className={BUTTON}
                      disabled={busy || !!snapshot.state.pending}
                      onClick={() =>
                        void perform(async () => {
                          await runtime.client.commit(tradeQuote)
                          setTradeQuote(null)
                        })
                      }
                    >
                      Confirm USD target
                    </button>
                    <button
                      className="min-h-11 w-full text-sm underline"
                      disabled={busy}
                      onClick={() => setTradeQuote(null)}
                    >
                      Cancel trade
                    </button>
                  </section>
                )}
                {snapshot.state.pending && (
                  <p className="rounded-xl bg-dark-elevated p-4 text-sm">
                    A {snapshot.state.pending.kind} is pending. Its result can arrive after
                    reconnecting. Do not pay its fee again.
                  </p>
                )}
                {position && (
                  <button
                    className="min-h-12 rounded-xl border border-on-dark/20 px-4 text-sm"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await runtime.client.pause(!snapshot.state!.paused)
                      })
                    }
                  >
                    {snapshot.state.paused
                      ? 'Resume automatic settlement'
                      : 'Pause automatic settlement'}
                  </button>
                )}
              </>
            )}
            <button
              className="min-h-11 text-sm underline"
              disabled={busy}
              onClick={() => void perform(runtime.client.refresh)}
            >
              Refresh USD prices
            </button>
          </>
        )}
        <p className="text-xs leading-relaxed text-[var(--color-on-dark-muted)]">
          Keep the wallet open and online for settlement. The USD target depends on the provider
          continuing to settle and having enough collateral. Closing the channel returns bitcoin at
          its then-current value.
        </p>
        <button
          className="min-h-11 text-sm underline"
          onClick={() => void navigate('/settings/advanced/peers')}
        >
          Manage or close channels
        </button>
      </div>
    </div>
  )
}
