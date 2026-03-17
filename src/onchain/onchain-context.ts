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
      estimateMaxSendable: (address: string) => Promise<MaxSendEstimate>
      sendToAddress: (address: string, amountSats: bigint, feeRateSatVb?: bigint) => Promise<string>
      sendMax: (address: string, feeRateSatVb?: bigint) => Promise<string>
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
