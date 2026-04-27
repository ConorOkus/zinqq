import { createContext } from 'react'
import type { Wallet, Psbt } from '@bitcoindevkit/bdk-wallet-web'
import type { OnchainBalance } from './sync'

/**
 * Optional hook invoked between PSBT build and signing. Receives the
 * unsigned PSBT plus context; returns either the same PSBT (declined,
 * sign as-is) or a transformed PSBT (e.g. a Payjoin proposal).
 *
 * Throwing aborts the send. The MAX_FEE_SATS sanity check re-runs on
 * whatever PSBT this returns.
 */
export type TransformPsbtHook = (
  unsigned: Psbt,
  ctx: { wallet: Wallet; feeRate: bigint; signal: AbortSignal }
) => Promise<Psbt>

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
      sendToAddress: (
        address: string,
        amountSats: bigint,
        feeRateSatVb?: bigint,
        transformPsbt?: TransformPsbtHook
      ) => Promise<string>
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
