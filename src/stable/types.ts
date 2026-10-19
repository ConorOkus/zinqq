import type { Correlation } from './protocol'
import type { PriceQuote } from './price'

export interface StableProvider {
  nodeId: string
  host: string
  port: number
}
export interface StablePosition {
  channelId: string
  targetUsd: number
  backingSats: string
  syncVersion: string
  lastSettlementAt: number
  receipts: Record<string, string>
}
export interface StableIntent {
  kind: 'trade' | 'settlement'
  paymentId: string
  preimage: string
  amountMsat: string
  tlv: string
  payload: string
  createdAt: number
  channelId: string
  targetUsd: number
  backingSats: string
  correlation: Correlation | null
  sent: boolean
}
export interface StableState {
  schema: 1
  revision: number
  enabled: boolean
  paused: boolean
  provider: StableProvider
  position: StablePosition | null
  pending: StableIntent | null
  notice: string | null
  inbox: {
    paymentId: string
    amountMsat: string
    channelIds: string[]
    receivedAt: number
    records: { type: string; value: string }[]
  }[]
}
export interface StableChannel {
  channelId: string
  userChannelId: string
  receiverSats: bigint
  spendableSats: bigint
  inboundSats: bigint
  usable: boolean
}
export interface StableTradeQuote {
  baseline: number
  channelId: string
  targetCents: bigint
  backingSats: bigint
  feeSats: bigint
  price: PriceQuote
}
export type StablePaymentEvent =
  | { kind: 'sent' | 'failed'; paymentId: string }
  | {
      kind: 'received'
      paymentId: string
      amountMsat: bigint
      channelIds: string[]
      records: { type: bigint; value: Uint8Array }[]
    }

export interface StableSnapshot {
  state: StableState | null
  price: PriceQuote | null
  priceFresh: boolean
  channel: StableChannel | null
  status: string
  error: string | null
  busy: boolean
}
