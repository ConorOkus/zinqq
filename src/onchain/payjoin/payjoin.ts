import { Psbt, type Wallet } from '@bitcoindevkit/bdk-wallet-web'
import { captureError } from '../../storage/error-log'
import type { PayjoinContext } from '../../ldk/payment-input'
import { loadPdk } from './pdk'
import { validateProposal } from './proposal-validator'

/**
 * Default OHTTP relay. Public, run by Ben Allen. The plan considered
 * ordered fallback across multiple relays as a hardening item but the
 * marginal availability gain doesn't justify the per-poll discovery
 * cost; revisit if production telemetry shows recurring relay outages.
 */
const OHTTP_RELAY = 'https://pj.benalleng.com'

const SESSION_TIMEOUT_MS = 45_000
const POLL_DELAY_INITIAL_MS = 1_000
const POLL_DELAY_MAX_MS = 5_000

/**
 * Setting `localStorage.zinqq_payjoin_disabled = '1'` causes
 * `tryPayjoinSend` to skip the entire Payjoin path and return the
 * unmodified original PSBT. Incident-response lever: cached service
 * workers may delay a code revert by hours, but the user-set flag is
 * effective on next send.
 */
const KILL_SWITCH_KEY = 'zinqq_payjoin_disabled'

/**
 * Why a Payjoin attempt failed. The 7 fine-grained reasons here are
 * collapsed to 2 buckets at telemetry emission to deny a hostile
 * receiver the ability to fingerprint our error path; the granular
 * reason stays in the captureError detail string for debugging.
 */
type FallbackReason =
  | 'pdk_load'
  | 'pdk_error'
  | 'network'
  | 'timeout'
  | 'validation'
  | 'backgrounded'
  | 'unknown'

const VALIDATION_REASONS = new Set<FallbackReason>(['validation'])

export class PayjoinFallback extends Error {
  readonly reason: FallbackReason
  constructor(reason: FallbackReason, message: string) {
    super(message)
    this.name = 'PayjoinFallback'
    this.reason = reason
  }
}

class MemSenderPersister {
  private events: string[] = []
  save(event: string): void {
    this.events.push(event)
  }
  load(): string[] {
    return this.events
  }
  close(): void {}
}

/**
 * Abort-aware sleep. Resolves after `ms` ms, or rejects with the
 * signal's abort reason (coerced to Error) if the signal fires first.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  const reason = (): Error =>
    signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(reason())
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(reason())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function emitOutcome(reason: FallbackReason | 'succeeded', detail?: string): void {
  const bucket =
    reason === 'succeeded'
      ? 'payjoin_succeeded'
      : VALIDATION_REASONS.has(reason)
        ? 'payjoin_fallback_validation'
        : 'payjoin_fallback_transient'
  captureError('warning', 'Payjoin', bucket, detail ?? reason)
}

function isKillSwitchEnabled(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(KILL_SWITCH_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Composes signal cancellation with a session-wide timeout. Returns the
 * combined signal plus a cleanup function. Caller must call cleanup() to
 * avoid leaking the timeout handle.
 */
function composeSignal(parent: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController()
  const reason = (s: AbortSignal): Error =>
    s.reason instanceof Error ? s.reason : new Error(String(s.reason))
  if (parent.aborted) {
    ctrl.abort(reason(parent))
    return { signal: ctrl.signal, cleanup: () => {} }
  }
  const onParentAbort = () => ctrl.abort(reason(parent))
  parent.addEventListener('abort', onParentAbort, { once: true })
  const timer = setTimeout(
    () => ctrl.abort(new Error('payjoin session timeout')),
    SESSION_TIMEOUT_MS
  )
  return {
    signal: ctrl.signal,
    cleanup: () => {
      parent.removeEventListener('abort', onParentAbort)
      clearTimeout(timer)
    },
  }
}

/**
 * Attempt to negotiate a Payjoin v2 proposal with the receiver and return
 * the proposal PSBT. On any failure throws `PayjoinFallback` so the caller
 * can fall back to signing the original PSBT.
 *
 * Returns the original PSBT unchanged (no throw) when the kill switch is
 * active — pre-flight skip with no telemetry.
 */
export async function tryPayjoinSend(
  unsigned: Psbt,
  payjoinCtx: PayjoinContext,
  ctx: { wallet: Wallet; feeRate: bigint; signal: AbortSignal }
): Promise<Psbt> {
  if (isKillSwitchEnabled()) {
    return unsigned
  }

  let pdk: Awaited<ReturnType<typeof loadPdk>>
  try {
    pdk = await loadPdk()
  } catch (err) {
    throw new PayjoinFallback('pdk_load', err instanceof Error ? err.message : String(err))
  }

  const composed = composeSignal(ctx.signal)
  try {
    let pjUri: ReturnType<typeof pdk.Uri.parse> extends infer U
      ? U extends { checkPjSupported(): infer R }
        ? R
        : never
      : never
    try {
      pjUri = pdk.Uri.parse(payjoinCtx.url).checkPjSupported()
    } catch (err) {
      throw new PayjoinFallback(
        'pdk_error',
        `URI parse: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    const persister = new MemSenderPersister()
    let reqCtx: ReturnType<
      ReturnType<InstanceType<typeof pdk.SenderBuilder>['buildRecommended']>['save']
    >
    try {
      reqCtx = new pdk.SenderBuilder(unsigned.toString(), pjUri)
        .buildRecommended(ctx.feeRate)
        .save(persister)
    } catch (err) {
      throw new PayjoinFallback(
        'pdk_error',
        `SenderBuilder: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    // Initial POST: send the original PSBT to the receiver via OHTTP relay.
    let sendCtx: ReturnType<ReturnType<typeof reqCtx.processResponse>['save']>
    try {
      const request = reqCtx.createV2PostRequest(OHTTP_RELAY)
      const response = await fetch(request.request.url, {
        method: 'POST',
        headers: { 'content-type': request.request.contentType },
        body: request.request.body,
        signal: composed.signal,
      })
      if (!response.ok) {
        throw new PayjoinFallback('network', `initial POST status ${response.status}`)
      }
      const buf = await response.arrayBuffer()
      sendCtx = reqCtx.processResponse(buf, request.ohttpCtx).save(persister)
    } catch (err) {
      if (err instanceof PayjoinFallback) throw err
      if (composed.signal.aborted) {
        throw new PayjoinFallback('backgrounded', 'aborted during initial POST')
      }
      throw new PayjoinFallback('network', err instanceof Error ? err.message : String(err))
    }

    // Poll loop: 1s → 5s exponential backoff, capped at SESSION_TIMEOUT_MS
    // total. Each iteration re-checks abort before sleep so cancellation is
    // bounded by the current poll RTT, not the next backoff.
    let delayMs = POLL_DELAY_INITIAL_MS
    while (true) {
      if (composed.signal.aborted) {
        throw new PayjoinFallback('backgrounded', 'aborted during poll')
      }

      let outcome: ReturnType<ReturnType<typeof sendCtx.processResponse>['save']>
      try {
        const pollReq = sendCtx.createPollRequest(OHTTP_RELAY)
        const response = await fetch(pollReq.request.url, {
          method: 'POST',
          headers: { 'content-type': pollReq.request.contentType },
          body: pollReq.request.body,
          signal: composed.signal,
        })
        const respBuf = await response.arrayBuffer()
        outcome = sendCtx.processResponse(respBuf, pollReq.ohttpCtx).save(persister)
      } catch (err) {
        if (err instanceof PayjoinFallback) throw err
        if (composed.signal.aborted) {
          throw new PayjoinFallback(
            ctx.signal.aborted ? 'backgrounded' : 'timeout',
            'aborted during poll'
          )
        }
        throw new PayjoinFallback('network', err instanceof Error ? err.message : String(err))
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
      if (outcome.tag === 'Progress') {
        let proposalPsbt: Psbt
        try {
          proposalPsbt = Psbt.from_string(outcome.inner.psbtBase64)
        } catch (err) {
          throw new PayjoinFallback(
            'pdk_error',
            `proposal PSBT decode: ${err instanceof Error ? err.message : String(err)}`
          )
        }
        const validation = validateProposal({
          original: unsigned,
          proposal: proposalPsbt,
          wallet: ctx.wallet,
          originalFeeRate: ctx.feeRate,
        })
        if (!validation.ok) {
          throw new PayjoinFallback('validation', validation.reason)
        }
        emitOutcome('succeeded')
        return proposalPsbt
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
      if (outcome.tag === 'Stasis') {
        // Receiver hasn't replied yet — adopt the new polling context PDK
        // returned and continue.
        sendCtx = outcome.inner.inner
      }

      await sleep(delayMs, composed.signal)
      delayMs = Math.min(Math.floor(delayMs * 1.5), POLL_DELAY_MAX_MS)
    }
  } catch (err) {
    if (err instanceof PayjoinFallback) {
      emitOutcome(err.reason, err.message)
    } else {
      emitOutcome('unknown', err instanceof Error ? err.message : String(err))
    }
    throw err
  } finally {
    composed.cleanup()
  }
}
