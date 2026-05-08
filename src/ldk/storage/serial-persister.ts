/**
 * Single-flight + trailing-coalesce + must-retry primitive used to wrap any
 * persist operation that:
 *   1. must not run concurrently with itself (race-prone state),
 *   2. should coalesce bursts of "schedule" calls into one leading + at most
 *      one trailing run,
 *   3. should retry on the next call if a previous run threw, even when no
 *      new work has been signalled.
 *
 * Originally extracted from `createChannelManagerPersistScheduler` in
 * `persist-cm.ts` so the same semantics can be applied to other VSS-backed
 * persisters (`known-peers.ts`, `recovery-state.ts`) — see todo #344.
 */

export interface SerialPersister {
  /**
   * Schedule a persist. Returns a promise that resolves when the run that
   * satisfies this call settles. Coalesced waiters share one in-flight
   * promise, so `await schedule()` does not strictly mean "my mutation is
   * durable" — see todo #339 for the per-call settle follow-up.
   */
  schedule: () => Promise<void>
  /**
   * Suppress further iterations. An in-flight call is allowed to finish
   * (we cannot safely abort mid-network); subsequent `schedule()` calls
   * become no-ops. Used in teardown to keep this tab from clobbering a
   * new tab after wallet-takeover.
   */
  cancel: () => void
}

/**
 * @param doPersist - Async function to invoke per iteration.
 * @param hasPendingWork - Optional source-of-truth dirty check (e.g. LDK's
 *   `cm.get_and_clear_needs_persistence()`). When provided:
 *     - `schedule()` sets pendingDirty only if this returns true,
 *     - the IIFE re-checks at iteration boundaries to fold a signal that
 *       arrived during the previous await,
 *     - returns false → schedule() is a no-op (skip the round-trip).
 *   When omitted, every `schedule()` call counts as work — appropriate for
 *   persisters whose only signal is the call itself (no separate dirty bit).
 */
export function createSerialPersister(
  doPersist: () => Promise<void>,
  hasPendingWork?: () => boolean
): SerialPersister {
  let inFlight: Promise<void> | null = null
  let pendingDirty = false
  let mustRetry = false
  let cancelled = false

  function consumeDirty(): void {
    if (hasPendingWork === undefined || hasPendingWork()) pendingDirty = true
  }

  function schedule(): Promise<void> {
    if (cancelled) return Promise.resolve()

    consumeDirty()

    if (!pendingDirty && !mustRetry) {
      return inFlight ?? Promise.resolve()
    }

    if (inFlight) return inFlight

    inFlight = (async () => {
      while (!cancelled) {
        // Fold a late signal that arrived during the previous iteration's
        // await. Only meaningful when `hasPendingWork` is provided — without
        // it, the only way pendingDirty gets re-set during the await is
        // another external `schedule()` call, which already sets it.
        if (hasPendingWork !== undefined && hasPendingWork()) pendingDirty = true
        if (!pendingDirty && !mustRetry) break

        pendingDirty = false
        mustRetry = false
        try {
          await doPersist()
        } catch (err) {
          // Caller's signal (e.g., LDK's dirty bit) was already consumed for
          // this iteration; latch mustRetry so the next schedule() picks up
          // the work even if no new signal fires. Surface the error to the
          // awaiter and stop looping — the caller's own retry path
          // (chain-sync tick, event drain) re-enters.
          mustRetry = true
          throw err
        }
      }
    })().finally(() => {
      inFlight = null
    })

    return inFlight
  }

  return {
    schedule,
    cancel: () => {
      cancelled = true
    },
  }
}
