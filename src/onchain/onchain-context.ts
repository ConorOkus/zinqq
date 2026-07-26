import { createContext } from 'react'
import type { OnchainBalance } from './sync'

export interface FeeEstimate {
  fee: bigint
  feeRate: bigint
}

export interface MaxSendEstimate {
  amount: bigint
  fee: bigint
  feeRate: bigint
  /** Anchor reserve withheld for Lightning channel safety (0n when no channels are open). */
  reserveSats: bigint
}

export interface OnchainTransaction {
  txid: string
  sent: bigint
  received: bigint
  confirmationTime: bigint | null
  firstSeen: bigint | null
  isConfirmed: boolean
}

export type OnchainContextValue =
  | { status: 'loading'; balance: null; error: null }
  | {
      status: 'ready'
      balance: OnchainBalance
      listTransactions: () => OnchainTransaction[]
      generateAddress: () => string
      estimateFee: (address: string, amountSats: bigint) => Promise<FeeEstimate>
      /**
       * Estimate the send-all amount. Pass `feeRateSatVb` to pin the estimate to
       * a previously reviewed fee rate (confirm-time drift check); omitted, the
       * current cached fee rate is fetched.
       */
      estimateMaxSendable: (address: string, feeRateSatVb?: bigint) => Promise<MaxSendEstimate>
      /**
       * Approximate send-all prefill: confirmed + trustedPending minus the anchor
       * reserve (when Lightning channels are open), clamped at 0. Fee is not
       * subtracted — the exact amount is recomputed at review via estimateMaxSendable.
       */
      approxMaxSpendable: () => bigint
      sendToAddress: (address: string, amountSats: bigint, feeRateSatVb?: bigint) => Promise<string>
      /**
       * Send all spendable funds. When `expectedAmountSats` is provided, the
       * built transaction's recipient output is asserted to equal it at the
       * broadcast boundary; on mismatch nothing is signed or broadcast and the
       * call rejects with AMOUNT_DRIFT_MESSAGE (see send-guards.ts).
       */
      sendMax: (
        address: string,
        feeRateSatVb?: bigint,
        expectedAmountSats?: bigint
      ) => Promise<string>
      /** Trigger an immediate BDK wallet sync with retries. Used after channel close. */
      syncNow: () => void
      error: null
    }
  | { status: 'error'; balance: null; error: Error }

export const defaultOnchainContextValue: OnchainContextValue = {
  status: 'loading',
  balance: null,
  error: null,
}

export const OnchainContext = createContext<OnchainContextValue>(defaultOnchainContextValue)
