import { useEffect, useState } from 'react'
import { type SpliceController, splicePending, type SpliceQuote } from '../stable/splice'
import { formatBtc } from '../utils/format-btc'
import { ActionHelp } from './ActionHelp'

export function SpliceFunding({ controller }: { controller: SpliceController }) {
  const [, refresh] = useState(0)
  useEffect(() => controller.subscribe(() => refresh((n) => n + 1)), [controller])
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState<SpliceQuote | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const state = controller.state
  const pending = splicePending(state)
  const button =
    'min-h-12 w-full rounded-xl bg-accent px-4 py-3 font-semibold text-dark disabled:opacity-40'
  async function perform(work: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to add funds')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className="space-y-3 rounded-2xl border border-on-dark/15 p-4"
      aria-label="Add on-chain funds"
    >
      <h2 className="font-semibold">Add funds</h2>
      <p className="text-sm text-[var(--color-on-dark-muted)]">
        Move confirmed on-chain bitcoin into this channel. After confirmation, your added balance
        will be requested as dollars, subject to the provider’s acceptance and 1% trade fee.
      </p>
      {pending ? (
        <>
          <p role="status" className="text-sm">
            {state?.status === 'prepared'
              ? 'Preparing channel funding'
              : state?.status === 'negotiating'
                ? 'Negotiating with the provider'
                : 'Adding funds · waiting for confirmation'}
          </p>
          {!state?.signedTx && (
            <button
              className="min-h-11 w-full text-sm underline"
              disabled={busy}
              onClick={() => void perform(controller.cancelUnsigned)}
            >
              Cancel pending request
            </button>
          )}
        </>
      ) : (
        <>
          {state?.status === 'complete' && (
            <p role="status" className="text-sm">
              {state.conversion === 'done'
                ? 'Added to channel. Dollar allocation requested.'
                : state.conversion === 'attempted'
                  ? 'Added to channel. Check the dollar allocation status.'
                  : 'Added to channel. Waiting to allocate dollars.'}
            </p>
          )}
          {quote ? (
            <>
              <p>Adding: {formatBtc(BigInt(quote.amountSats))}</p>
              <p>Maximum mining fee: {formatBtc(BigInt(quote.maxFeeSats))}</p>
              <p className="text-sm text-[var(--color-on-dark-muted)]">
                At least 10,000 sats stays on-chain as a safety reserve.
              </p>
              <p className="text-sm text-[var(--color-on-dark-muted)]">
                {quote.feeRate} sat/vB · Mainnet
              </p>
              <button
                className={button}
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await controller.commit(quote)
                    setQuote(null)
                  })
                }
              >
                {busy ? 'Adding funds…' : 'Confirm add funds'}
              </button>
              <button
                className="min-h-11 w-full text-sm underline"
                disabled={busy}
                onClick={() => setQuote(null)}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <label className="block text-sm">
                Amount
                <input
                  className="mt-2 min-h-12 w-full rounded-xl border border-on-dark/20 bg-dark-elevated px-4 text-on-dark"
                  inputMode="numeric"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </label>
              <ActionHelp
                label="About maximum amount"
                text="Maximum uses confirmed funds after the mining-fee allowance and a 10,000-sat on-chain safety reserve."
              >
                <button
                  className="min-h-11 text-sm font-semibold underline disabled:opacity-40"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      const maximum = await controller.quoteMaximum()
                      setAmount(maximum.amountSats)
                    })
                  }
                >
                  Use maximum
                </button>
              </ActionHelp>
              <button
                className={button}
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    if (!/^\d{1,12}$/.test(amount)) throw new Error('Enter an amount in sats')
                    setQuote(await controller.quote(BigInt(amount)))
                  })
                }
              >
                {busy ? 'Preparing review…' : 'Review'}
              </button>
            </>
          )}
        </>
      )}
      {(error || controller.error || state?.error) && (
        <p role="alert" className="text-sm text-danger">
          {error ?? controller.error ?? state?.error}
        </p>
      )}
    </section>
  )
}
