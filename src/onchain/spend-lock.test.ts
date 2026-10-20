import { expect, it } from 'vitest'
import { beginWalletSpend, walletSpendInProgress } from './spend-lock'

it('prevents overlapping input selection and ignores a stale release', () => {
  const first = beginWalletSpend()
  expect(walletSpendInProgress()).toBe(true)
  expect(beginWalletSpend).toThrow(/Another on-chain transaction/)
  first()
  const second = beginWalletSpend()
  first()
  expect(beginWalletSpend).toThrow(/Another on-chain transaction/)
  second()
  expect(walletSpendInProgress()).toBe(false)
})
