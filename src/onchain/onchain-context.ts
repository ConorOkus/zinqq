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

export type OnchainContextValue =
  | { status: 'loading'; balance: null; error: null }
  | {
      status: 'ready'
      balance: OnchainBalance
      generateAddress: () => string
      estimateFee: (address: string, amountSats: bigint) => Promise<FeeEstimate>
      estimateMaxSendable: (address: string) => Promise<MaxSendEstimate>
      sendToAddress: (address: string, amountSats: bigint, feeRateSatVb?: bigint) => Promise<string>
      sendMax: (address: string, feeRateSatVb?: bigint) => Promise<string>
      error: null
    }
  | { status: 'error'; balance: null; error: Error }

export const defaultOnchainContextValue: OnchainContextValue = {
  status: 'loading',
  balance: null,
  error: null,
}

export const OnchainContext = createContext<OnchainContextValue>(defaultOnchainContextValue)
