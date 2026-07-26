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

/** The slice of a built PSBT the drift check inspects. Structurally matches BDK-WASM's Psbt. */
export type DriftCheckPsbt = {
  unsigned_tx: {
    output: Array<{
      script_pubkey: { to_hex_string(): string }
      value: { to_sat(): bigint }
    }>
  }
}

/**
 * Build the broadcast-boundary drift check (R5) from plain values captured
 * BEFORE any consuming BDK build call. The closure must hold no wasm objects:
 * builder calls like Recipient.from_address consume their arguments, so a
 * captured Address or ScriptBuf would be destroyed by the time the check runs
 * inside buildSignBroadcast ("null pointer passed to rust").
 */
export function makeDriftCheck(
  recipientScriptHex: string,
  expectedAmountSats: bigint
): (psbt: DriftCheckPsbt) => Error | null {
  return (psbt) => {
    const recipientOutput = psbt.unsigned_tx.output.find(
      (out) => out.script_pubkey.to_hex_string() === recipientScriptHex
    )
    return checkAmountDrift(
      expectedAmountSats,
      recipientOutput ? recipientOutput.value.to_sat() : null
    )
  }
}

/**
 * Typed sentinel for the confirm-time drift guard (R5): the transaction built
 * at the broadcast boundary would pay the recipient a different amount than
 * the one the user reviewed. Callers match on this exact message to route back
 * to a refreshed review instead of the error screen.
 *
 * Wording note: must not contain "network", "validation", or "dust" — the
 * context layer's mapSendError rewrites messages containing those keywords.
 */
export const AMOUNT_DRIFT_MESSAGE = 'Send amount changed since review'

/**
 * Confirm-time drift guard for send-all: compares the reviewed amount against
 * the recipient output actually present in the built transaction.
 *
 * @param expectedSats      the amount the user confirmed on the review screen
 * @param builtOutputSats   value of the recipient/drain output in the built
 *                          PSBT, or null when no output pays the recipient
 * @returns an Error with {@link AMOUNT_DRIFT_MESSAGE} on any mismatch
 *          (including a missing output), or null when they match exactly
 */
export function checkAmountDrift(
  expectedSats: bigint,
  builtOutputSats: bigint | null
): Error | null {
  if (builtOutputSats === null || builtOutputSats !== expectedSats) {
    return new Error(AMOUNT_DRIFT_MESSAGE)
  }
  return null
}
