import { describe, it, expect } from 'vitest'
import type { Psbt, Wallet, ScriptBuf } from '@bitcoindevkit/bdk-wallet-web'
import { validateProposal } from './proposal-validator'

// Structural fakes match only the surfaces validateProposal reads. Cast through
// `unknown` so we don't need to satisfy the full BDK class shape (private
// constructors, [Symbol.dispose], etc.). Keep these helpers tight: any new read
// in validateProposal needs a corresponding field here.

function fakeScript(bytes: number[]): ScriptBuf {
  return { as_bytes: () => new Uint8Array(bytes) } as unknown as ScriptBuf
}

function fakeOutPoint(txid: string, vout: number) {
  return { previous_output: { txid: { toString: () => txid }, vout } }
}

function fakeOutput(value: bigint, script: ScriptBuf) {
  return { script_pubkey: script, value: { to_sat: () => value } }
}

function fakePsbt(opts: {
  version: number
  isLockTimeEnabled?: boolean
  inputs: ReturnType<typeof fakeOutPoint>[]
  outputs: ReturnType<typeof fakeOutput>[]
  fee: bigint
}): Psbt {
  return {
    version: opts.version,
    unsigned_tx: {
      input: opts.inputs,
      output: opts.outputs,
      is_lock_time_enabled: opts.isLockTimeEnabled ?? false,
    },
    fee: () => ({ to_sat: () => opts.fee }),
  } as unknown as Psbt
}

/** Wallet mock: scripts in `ownedScripts` (compared by byte equality) are ours. */
function fakeWallet(ownedScripts: ScriptBuf[]): Wallet {
  const ownedHex = ownedScripts.map((s) =>
    Array.from(s.as_bytes())
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  )
  return {
    is_mine: (script: ScriptBuf) => {
      const hex = Array.from(script.as_bytes())
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
      return ownedHex.includes(hex)
    },
  } as unknown as Wallet
}

const SENDER_CHANGE = fakeScript([0x00, 0x14, 0x01, 0x02, 0x03])
const RECIPIENT = fakeScript([0x00, 0x14, 0x99, 0x88, 0x77])
const RECEIVER_INPUT_SCRIPT = fakeScript([0x00, 0x14, 0xaa, 0xbb, 0xcc])

describe('validateProposal', () => {
  it('accepts an unchanged proposal (degenerate Payjoin / no contribution)', () => {
    const original = fakePsbt({
      version: 2,
      inputs: [fakeOutPoint('aa', 0)],
      outputs: [fakeOutput(1000n, RECIPIENT), fakeOutput(99_000n, SENDER_CHANGE)],
      fee: 1_000n,
    })
    const result = validateProposal({
      original,
      proposal: original,
      wallet: fakeWallet([SENDER_CHANGE]),
      originalFeeRate: 10n,
    })
    expect(result).toEqual({ ok: true })
  })

  it('accepts a proposal that adds a receiver input and reduces sender change within cap', () => {
    const original = fakePsbt({
      version: 2,
      inputs: [fakeOutPoint('aa', 0)],
      outputs: [fakeOutput(1000n, RECIPIENT), fakeOutput(99_000n, SENDER_CHANGE)],
      fee: 1_000n,
    })
    const proposal = fakePsbt({
      version: 2,
      inputs: [fakeOutPoint('aa', 0), fakeOutPoint('bb', 1)],
      // sender change reduced by 500 sats (well under feeRate * 110 = 1100 cap)
      outputs: [fakeOutput(1000n, RECIPIENT), fakeOutput(98_500n, SENDER_CHANGE)],
      fee: 1_500n,
    })
    const result = validateProposal({
      original,
      proposal,
      wallet: fakeWallet([SENDER_CHANGE]),
      originalFeeRate: 10n,
    })
    expect(result).toEqual({ ok: true })
  })

  it('rejects when the receiver drops a sender input', () => {
    const original = fakePsbt({
      version: 2,
      inputs: [fakeOutPoint('aa', 0), fakeOutPoint('bb', 0)],
      outputs: [fakeOutput(1000n, RECIPIENT), fakeOutput(99_000n, SENDER_CHANGE)],
      fee: 1_000n,
    })
    const proposal = fakePsbt({
      version: 2,
      inputs: [fakeOutPoint('aa', 0)], // bb:0 dropped
      outputs: [fakeOutput(1000n, RECIPIENT), fakeOutput(99_000n, SENDER_CHANGE)],
      fee: 1_000n,
    })
    const result = validateProposal({
      original,
      proposal,
      wallet: fakeWallet([SENDER_CHANGE]),
      originalFeeRate: 10n,
    })
    expect(result).toEqual({ ok: false, reason: 'sender input dropped' })
  })

  it('rejects when the recipient amount is decreased', () => {
    const original = fakePsbt({
      version: 2,
      inputs: [fakeOutPoint('aa', 0)],
      outputs: [fakeOutput(1000n, RECIPIENT), fakeOutput(99_000n, SENDER_CHANGE)],
      fee: 1_000n,
    })
    const proposal = fakePsbt({
      version: 2,
      inputs: [fakeOutPoint('aa', 0)],
      outputs: [fakeOutput(900n, RECIPIENT), fakeOutput(99_000n, SENDER_CHANGE)],
      fee: 1_100n,
    })
    const result = validateProposal({
      original,
      proposal,
      wallet: fakeWallet([SENDER_CHANGE]),
      originalFeeRate: 10n,
    })
    expect(result).toEqual({ ok: false, reason: 'recipient amount decreased' })
  })

  it('rejects when sender change is reduced beyond the weight-based fee cap', () => {
    const original = fakePsbt({
      version: 2,
      inputs: [fakeOutPoint('aa', 0)],
      outputs: [fakeOutput(1000n, RECIPIENT), fakeOutput(99_000n, SENDER_CHANGE)],
      fee: 1_000n,
    })
    // feeRate * 110 = 10 * 110 = 1100 sat ceiling. Decrease of 1500 exceeds.
    const proposal = fakePsbt({
      version: 2,
      inputs: [fakeOutPoint('aa', 0), fakeOutPoint('bb', 1)],
      outputs: [fakeOutput(1000n, RECIPIENT), fakeOutput(97_500n, SENDER_CHANGE)],
      fee: 2_500n,
    })
    const result = validateProposal({
      original,
      proposal,
      wallet: fakeWallet([SENDER_CHANGE]),
      originalFeeRate: 10n,
    })
    // Total fee delta (1500) also exceeds cap (1100), so the fee check fires
    // before the per-output check. Either reason is acceptable as a reject.
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(['fee contribution exceeds cap', 'sender change reduced beyond fee cap']).toContain(
        result.reason
      )
    }
  })

  it('rejects when total fee exceeds originalFee + originalFeeRate * 110', () => {
    const original = fakePsbt({
      version: 2,
      inputs: [fakeOutPoint('aa', 0)],
      outputs: [fakeOutput(1000n, RECIPIENT), fakeOutput(99_000n, SENDER_CHANGE)],
      fee: 1_000n,
    })
    // cap = 1000 + (10 * 110) = 2100. proposal fee 2200 exceeds.
    const proposal = fakePsbt({
      version: 2,
      inputs: [fakeOutPoint('aa', 0), fakeOutPoint('bb', 1)],
      outputs: [fakeOutput(1000n, RECIPIENT), fakeOutput(97_800n, SENDER_CHANGE)],
      fee: 2_200n,
    })
    const result = validateProposal({
      original,
      proposal,
      wallet: fakeWallet([SENDER_CHANGE]),
      originalFeeRate: 10n,
    })
    expect(result).toEqual({ ok: false, reason: 'fee contribution exceeds cap' })
  })

  it('rejects when proposal changes the psbt version', () => {
    const original = fakePsbt({
      version: 2,
      inputs: [fakeOutPoint('aa', 0)],
      outputs: [fakeOutput(1000n, RECIPIENT), fakeOutput(99_000n, SENDER_CHANGE)],
      fee: 1_000n,
    })
    const proposal = fakePsbt({
      version: 1,
      inputs: [fakeOutPoint('aa', 0)],
      outputs: [fakeOutput(1000n, RECIPIENT), fakeOutput(99_000n, SENDER_CHANGE)],
      fee: 1_000n,
    })
    const result = validateProposal({
      original,
      proposal,
      wallet: fakeWallet([SENDER_CHANGE]),
      originalFeeRate: 10n,
    })
    expect(result).toEqual({ ok: false, reason: 'psbt version changed' })
  })

  it('rejects when proposal flips the locktime-enabled bit', () => {
    const original = fakePsbt({
      version: 2,
      isLockTimeEnabled: false,
      inputs: [fakeOutPoint('aa', 0)],
      outputs: [fakeOutput(1000n, RECIPIENT), fakeOutput(99_000n, SENDER_CHANGE)],
      fee: 1_000n,
    })
    const proposal = fakePsbt({
      version: 2,
      isLockTimeEnabled: true,
      inputs: [fakeOutPoint('aa', 0)],
      outputs: [fakeOutput(1000n, RECIPIENT), fakeOutput(99_000n, SENDER_CHANGE)],
      fee: 1_000n,
    })
    const result = validateProposal({
      original,
      proposal,
      wallet: fakeWallet([SENDER_CHANGE]),
      originalFeeRate: 10n,
    })
    expect(result).toEqual({ ok: false, reason: 'locktime-enabled bit changed' })
  })

  it('rejects when receiver adds a new output owned by the sender (UTXO grafting redirect)', () => {
    const RECEIVER_GRAFTED_OURS = fakeScript([0x00, 0x14, 0x12, 0x34, 0x56])
    const original = fakePsbt({
      version: 2,
      inputs: [fakeOutPoint('aa', 0)],
      outputs: [fakeOutput(1000n, RECIPIENT), fakeOutput(99_000n, SENDER_CHANGE)],
      fee: 1_000n,
    })
    // Receiver grafts a sender-owned UTXO as their "contribution" then adds a
    // fresh output paying that value to a different sender-owned script.
    // Without check (f), validateProposal would only iterate original outputs
    // and miss this entirely.
    const proposal = fakePsbt({
      version: 2,
      inputs: [fakeOutPoint('aa', 0), fakeOutPoint('grafted', 0)],
      outputs: [
        fakeOutput(1000n, RECIPIENT),
        fakeOutput(99_000n, SENDER_CHANGE),
        fakeOutput(50_000n, RECEIVER_GRAFTED_OURS),
      ],
      fee: 1_000n,
    })
    const result = validateProposal({
      original,
      proposal,
      wallet: fakeWallet([SENDER_CHANGE, RECEIVER_GRAFTED_OURS]),
      originalFeeRate: 10n,
    })
    expect(result).toEqual({ ok: false, reason: 'receiver added a sender-owned output' })
  })

  it('ignores a receiver-added input whose script is unrelated to the wallet', () => {
    // Sanity: receiver-added inputs don't appear in our outputs check; we just
    // verify the validator doesn't false-positive on a legitimate Payjoin shape.
    const original = fakePsbt({
      version: 2,
      inputs: [fakeOutPoint('aa', 0)],
      outputs: [fakeOutput(1000n, RECIPIENT), fakeOutput(99_000n, SENDER_CHANGE)],
      fee: 1_000n,
    })
    const proposal = fakePsbt({
      version: 2,
      inputs: [fakeOutPoint('aa', 0), fakeOutPoint('cc', 7)],
      outputs: [
        fakeOutput(1000n, RECIPIENT),
        fakeOutput(99_000n, SENDER_CHANGE),
        // receiver added their own output too — script not owned, validator
        // simply doesn't recurse into it.
        fakeOutput(50_000n, RECEIVER_INPUT_SCRIPT),
      ],
      fee: 1_000n,
    })
    const result = validateProposal({
      original,
      proposal,
      wallet: fakeWallet([SENDER_CHANGE]),
      originalFeeRate: 10n,
    })
    expect(result).toEqual({ ok: true })
  })
})
