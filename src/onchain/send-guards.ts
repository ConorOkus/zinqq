import { MAX_FEE_SATS } from './config'

/**
 * Friendly message when a send-all estimate leaves less than the recipient
 * script's dust floor after fees (or nothing at all).
 */
export const BALANCE_TOO_LOW_MESSAGE = 'Balance too low to cover fees'

/** Friendly message when the estimated absolute fee exceeds MAX_FEE_SATS. */
export const FEES_TOO_HIGH_MESSAGE = 'Network fees are too high right now — try again later.'

/**
 * Estimate-time guards for send-all: returns an Error when the outcome is
 * already knowable at estimate time, so it can surface as an inline message
 * on the amount step instead of a post-Confirm error screen.
 *
 * The fee ceiling is checked first — when both guards trip, "try again later"
 * is the actionable advice (fees may drop; the balance won't grow on its own).
 *
 * @param amount     estimated max-sendable amount (may be negative)
 * @param fee        estimated absolute fee in sats
 * @param dustFloor  recipient script's dust threshold from
 *                   `ScriptBuf.minimal_non_dust()` (294 sats P2WPKH, 546 P2PKH)
 */
export function checkMaxSendGuards(amount: bigint, fee: bigint, dustFloor: bigint): Error | null {
  if (fee > MAX_FEE_SATS) return new Error(FEES_TOO_HIGH_MESSAGE)
  if (amount < dustFloor) return new Error(BALANCE_TOO_LOW_MESSAGE)
  return null
}
