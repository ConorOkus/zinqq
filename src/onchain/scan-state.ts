/**
 * Tracks whether the initial BDK full scan has completed this session.
 *
 * Why it exists: on a wallet restore, LDK replays chain-monitor events
 * (including BumpTransaction CPFP requests) as soon as event processing
 * starts — before the freshly created BDK wallet has scanned the chain. At
 * that moment `list_unspent()` is empty BY CONSTRUCTION, so a "no confirmed
 * UTXOs → enter force-close recovery" check would fire on every restore
 * regardless of the wallet's real funds. Recovery signaling is gated on this
 * flag; a genuinely stuck close re-triggers naturally because LDK re-yields
 * bump events on each new block until the claim confirms.
 *
 * Module-level by design (mirrors close-records/store.ts): the flag is
 * per-app-session, and the Restore flow reloads the page, which resets it.
 */

let initialScanComplete = false

/** Called by `fullScanBdkWallet` after the first successful full scan. */
export function markInitialScanComplete(): void {
  initialScanComplete = true
}

export function isInitialScanComplete(): boolean {
  return initialScanComplete
}

/** Test seam. */
export function resetInitialScanStateForTests(): void {
  initialScanComplete = false
}
