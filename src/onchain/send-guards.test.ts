import { describe, it, expect } from 'vitest'
import {
  checkMaxSendGuards,
  checkAmountDrift,
  makeDriftCheck,
  BALANCE_TOO_LOW_MESSAGE,
  FEES_TOO_HIGH_MESSAGE,
  AMOUNT_DRIFT_MESSAGE,
} from './send-guards'
import { MAX_FEE_SATS } from './config'

describe('checkMaxSendGuards', () => {
  it('returns null when amount is at the dust floor and fee is at the ceiling (boundaries)', () => {
    expect(checkMaxSendGuards(294n, MAX_FEE_SATS, 294n)).toBeNull()
  })

  it('returns null for a comfortably valid estimate', () => {
    expect(checkMaxSendGuards(40_000n, 150n, 294n)).toBeNull()
  })

  it('flags an amount below the script dust floor', () => {
    const err = checkMaxSendGuards(293n, 150n, 294n)
    expect(err?.message).toBe(BALANCE_TOO_LOW_MESSAGE)
  })

  it('flags a negative amount (fee exceeds available balance)', () => {
    const err = checkMaxSendGuards(-100n, 150n, 294n)
    expect(err?.message).toBe(BALANCE_TOO_LOW_MESSAGE)
  })

  it('respects a larger legacy (P2PKH) dust floor', () => {
    const err = checkMaxSendGuards(545n, 150n, 546n)
    expect(err?.message).toBe(BALANCE_TOO_LOW_MESSAGE)
    expect(checkMaxSendGuards(546n, 150n, 546n)).toBeNull()
  })

  it('flags a fee above MAX_FEE_SATS', () => {
    const err = checkMaxSendGuards(100_000n, MAX_FEE_SATS + 1n, 294n)
    expect(err?.message).toBe(FEES_TOO_HIGH_MESSAGE)
  })

  it('prefers the fee-ceiling message when both guards trip', () => {
    // Fees may drop later, so "try again later" is the actionable advice
    const err = checkMaxSendGuards(200n, MAX_FEE_SATS + 1n, 294n)
    expect(err?.message).toBe(FEES_TOO_HIGH_MESSAGE)
  })
})

describe('checkAmountDrift', () => {
  it('returns null when the built output matches the reviewed amount exactly', () => {
    expect(checkAmountDrift(49_850n, 49_850n)).toBeNull()
  })

  it('flags a built output above the reviewed amount', () => {
    const err = checkAmountDrift(49_850n, 59_850n)
    expect(err?.message).toBe(AMOUNT_DRIFT_MESSAGE)
  })

  it('flags a built output below the reviewed amount', () => {
    const err = checkAmountDrift(49_850n, 39_850n)
    expect(err?.message).toBe(AMOUNT_DRIFT_MESSAGE)
  })

  it('flags a missing recipient output (null)', () => {
    const err = checkAmountDrift(49_850n, null)
    expect(err?.message).toBe(AMOUNT_DRIFT_MESSAGE)
  })

  it('flags a 1-sat drift (no tolerance window)', () => {
    const err = checkAmountDrift(49_850n, 49_849n)
    expect(err?.message).toBe(AMOUNT_DRIFT_MESSAGE)
  })
})

function fakePsbt(outputs: Array<{ scriptHex: string; sats: bigint }>) {
  return {
    unsigned_tx: {
      output: outputs.map((o) => ({
        script_pubkey: { to_hex_string: () => o.scriptHex },
        value: { to_sat: () => o.sats },
      })),
    },
  }
}

describe('makeDriftCheck', () => {
  const RECIPIENT = '0014aabbccdd'
  const CHANGE = '0014eeff0011'

  it('passes when the recipient output matches the reviewed amount exactly', () => {
    const check = makeDriftCheck(RECIPIENT, 49_850n)
    expect(check(fakePsbt([{ scriptHex: RECIPIENT, sats: 49_850n }]))).toBeNull()
  })

  it('finds the recipient output regardless of output order (change first)', () => {
    const check = makeDriftCheck(RECIPIENT, 49_850n)
    const psbt = fakePsbt([
      { scriptHex: CHANGE, sats: 10_000n },
      { scriptHex: RECIPIENT, sats: 49_850n },
    ])
    expect(check(psbt)).toBeNull()
  })

  it('flags a recipient output that differs from the reviewed amount', () => {
    const check = makeDriftCheck(RECIPIENT, 49_850n)
    const psbt = fakePsbt([
      { scriptHex: RECIPIENT, sats: 59_850n },
      { scriptHex: CHANGE, sats: 10_000n },
    ])
    expect(check(psbt)?.message).toBe(AMOUNT_DRIFT_MESSAGE)
  })

  it('flags a transaction with no output paying the recipient script', () => {
    const check = makeDriftCheck(RECIPIENT, 49_850n)
    expect(check(fakePsbt([{ scriptHex: CHANGE, sats: 49_850n }]))?.message).toBe(
      AMOUNT_DRIFT_MESSAGE
    )
  })

  it('holds no wasm objects: works on plain structural values', () => {
    // Regression for the consumed-Address bug: the check must be constructible
    // from a pre-captured hex string and run against any structurally matching
    // PSBT, with no live BDK objects in the closure.
    const check = makeDriftCheck(RECIPIENT, 1n)
    expect(check(fakePsbt([{ scriptHex: RECIPIENT, sats: 1n }]))).toBeNull()
  })
})
