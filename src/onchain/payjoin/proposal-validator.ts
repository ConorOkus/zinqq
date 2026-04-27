import type { Psbt, Wallet, ScriptBuf } from '@bitcoindevkit/bdk-wallet-web'

/** Maximum additional weight a receiver may contribute, in vbytes (BIP 78 canonical). */
const MAX_ADDITIONAL_VBYTES = 110n

export interface ValidationContext {
  original: Psbt
  proposal: Psbt
  wallet: Wallet
  /** Original PSBT's fee rate in sat/vB. Used for the weight-based fee cap. */
  originalFeeRate: bigint
}

export type ValidationResult = { ok: true } | { ok: false; reason: string }

function scriptsEqual(a: ScriptBuf, b: ScriptBuf): boolean {
  const aBytes = a.as_bytes()
  const bBytes = b.as_bytes()
  if (aBytes.length !== bBytes.length) return false
  for (let i = 0; i < aBytes.length; i++) {
    if (aBytes[i] !== bBytes[i]) return false
  }
  return true
}

/**
 * Sender-side defense-in-depth checks on a Payjoin proposal PSBT.
 * PDK already enforces BIP 78's full sender checklist; this guards
 * against PDK regressions and surfaces hostile-receiver signal.
 *
 * Checks performed:
 *   a) PSBT version preserved (the BDK Transaction class doesn't expose
 *      the consensus tx version; we compare the Psbt-level version
 *      instead — Psbt is built from the unsigned tx and inherits it).
 *   b) Locktime-enabled bit preserved (boolean parity; the actual
 *      locktime value isn't reachable from BDK's TS bindings).
 *   c) Every original sender input is still present (by OutPoint).
 *   d) Every wallet-owned output in the original is preserved by
 *      scriptPubKey and its value is not reduced by more than
 *      `originalFeeRate * 110` (BIP 78 weight cap on fee contribution).
 *   e) Every non-owned output (recipient) in the original is preserved
 *      by scriptPubKey and its value is not decreased.
 *   f) No proposal output that wasn't in the original may be wallet-
 *      owned. Catches the receiver-grafts-our-UTXO redirect attack.
 *   g) Total fee does not exceed `originalFee + originalFeeRate * 110`.
 *
 * Limitations: BDK's TS bindings do not expose PSBT input fields
 * (sighash_type, bip32_derivation, witness_utxo, redeem_script,
 * witness_script). Sighash and derivation-path checks rely on PDK's
 * BIP 78 checklist; if PDK regresses we have no fallback. See todo #267.
 */
export function validateProposal(ctx: ValidationContext): ValidationResult {
  const original = ctx.original.unsigned_tx
  const proposal = ctx.proposal.unsigned_tx

  // (a) Psbt-level version (Transaction.version is not exposed in BDK TS).
  if (ctx.proposal.version !== ctx.original.version) {
    return { ok: false, reason: 'psbt version changed' }
  }

  // (b) Locktime-enabled bit. BDK only exposes `is_lock_time_enabled`,
  // not the locktime value itself; we accept the loss in granularity.
  if (proposal.is_lock_time_enabled !== original.is_lock_time_enabled) {
    return { ok: false, reason: 'locktime-enabled bit changed' }
  }

  // (c) sender inputs preserved
  const propOutpoints = new Set(
    proposal.input.map((i) => `${i.previous_output.txid.toString()}:${i.previous_output.vout}`)
  )
  for (const inp of original.input) {
    const key = `${inp.previous_output.txid.toString()}:${inp.previous_output.vout}`
    if (!propOutpoints.has(key)) {
      return { ok: false, reason: 'sender input dropped' }
    }
  }

  // (g) total fee cap (weight-based, BIP 78 canonical)
  const maxAdditional = ctx.originalFeeRate * MAX_ADDITIONAL_VBYTES
  const proposalFee = ctx.proposal.fee().to_sat()
  const originalFee = ctx.original.fee().to_sat()
  if (proposalFee > originalFee + maxAdditional) {
    return { ok: false, reason: 'fee contribution exceeds cap' }
  }

  // (d) + (e) every original output is preserved by scriptPubKey, value bounded
  for (const origOut of original.output) {
    const ours = ctx.wallet.is_mine(origOut.script_pubkey)
    let matched = false
    for (const propOut of proposal.output) {
      if (!scriptsEqual(propOut.script_pubkey, origOut.script_pubkey)) continue
      const newValue = propOut.value.to_sat()
      const oldValue = origOut.value.to_sat()
      if (ours) {
        // Sender change: may decrease by at most maxAdditional.
        if (newValue + maxAdditional < oldValue) {
          return { ok: false, reason: 'sender change reduced beyond fee cap' }
        }
      } else {
        // Recipient: may not decrease at all.
        if (newValue < oldValue) {
          return { ok: false, reason: 'recipient amount decreased' }
        }
      }
      matched = true
      break
    }
    if (!matched) {
      return {
        ok: false,
        reason: ours ? 'sender change output dropped' : 'recipient output dropped',
      }
    }
  }

  // (f) any output the receiver added (script not present in original) must
  // NOT be wallet-owned. Without this, a hostile receiver could graft a
  // sender-owned UTXO and route its value to a fresh receiver-owned output;
  // PDK's BIP 78 sender checklist doesn't have wallet UTXO context, so this
  // is sender-side defense-in-depth.
  for (const propOut of proposal.output) {
    const inOriginal = original.output.some((o) =>
      scriptsEqual(o.script_pubkey, propOut.script_pubkey)
    )
    if (inOriginal) continue
    if (ctx.wallet.is_mine(propOut.script_pubkey)) {
      return { ok: false, reason: 'receiver added a sender-owned output' }
    }
  }

  return { ok: true }
}
