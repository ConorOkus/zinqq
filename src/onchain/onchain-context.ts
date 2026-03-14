import { createContext } from 'react'
import type { Wallet } from '@bitcoindevkit/bdk-wallet-web'
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
  | { status: 'loading'; balance: null; wallet: null; error: null }
  | {
      status: 'ready'
      balance: OnchainBalance
      wallet: Wallet
      generateAddress: () => string
      estimateFee: (address: string, amountSats: bigint) => Promise<FeeEstimate>
      estimateMaxSendable: (address: string) => Promise<MaxSendEstimate>
      sendToAddress: (address: string, amountSats: bigint) => Promise<string>
      sendMax: (address: string) => Promise<string>
      error: null
    }
  | { status: 'error'; balance: null; wallet: null; error: Error }

export const defaultOnchainContextValue: OnchainContextValue = {
  status: 'loading',
  balance: null,
  wallet: null,
  error: null,
}

export const OnchainContext = createContext<OnchainContextValue>(defaultOnchainContextValue)
