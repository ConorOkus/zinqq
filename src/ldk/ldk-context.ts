import { createContext } from 'react'
import type { Wallet } from '@bitcoindevkit/bdk-wallet-web'
import type { Bolt11Invoice, Offer, HumanReadableName, RecentPaymentDetails, ChannelDetails, ChannelId } from 'lightningdevkit'
import type { LdkNode } from './init'

export type SyncStatus = 'syncing' | 'synced' | 'stale'

export type PaymentResult =
  | { status: 'pending' }
  | { status: 'sent'; preimage: Uint8Array; feePaidMsat: bigint | null }
  | { status: 'failed'; reason: string }

export type LdkContextValue =
  | { status: 'loading'; node: null; nodeId: null; error: null }
  | {
      status: 'ready'
      node: LdkNode
      nodeId: string
      error: null
      syncStatus: SyncStatus
      connectToPeer: (pubkey: string, host: string, port: number) => Promise<void>
      forgetPeer: (pubkey: string) => Promise<void>
      createChannel: (counterpartyPubkey: Uint8Array, channelValueSats: bigint) => boolean
      closeChannel: (channelId: ChannelId, counterpartyNodeId: Uint8Array) => boolean
      forceCloseChannel: (channelId: ChannelId, counterpartyNodeId: Uint8Array) => boolean
      listChannels: () => ChannelDetails[]
      setBdkWallet: (wallet: Wallet | null) => void
      sendBolt11Payment: (invoice: Bolt11Invoice, amountMsat?: bigint) => Uint8Array
      sendBolt12Payment: (offer: Offer, amountMsat?: bigint, payerNote?: string) => Uint8Array
      sendBip353Payment: (name: HumanReadableName, amountMsat: bigint) => Uint8Array
      abandonPayment: (paymentId: Uint8Array) => void
      getPaymentResult: (paymentId: Uint8Array) => PaymentResult | null
      listRecentPayments: () => RecentPaymentDetails[]
      outboundCapacityMsat: () => bigint
    }
  | { status: 'error'; node: null; nodeId: null; error: Error }

export const defaultLdkContextValue: LdkContextValue = {
  status: 'loading',
  node: null,
  nodeId: null,
  error: null,
}

export const LdkContext = createContext<LdkContextValue>(defaultLdkContextValue)
