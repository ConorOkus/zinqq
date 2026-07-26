import { describe, it, expect } from 'vitest'
import { checkMaxSendGuards, BALANCE_TOO_LOW_MESSAGE, FEES_TOO_HIGH_MESSAGE } from './send-guards'
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
