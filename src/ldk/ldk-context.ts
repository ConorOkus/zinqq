import { createContext } from 'react'
import type { Wallet } from '@bitcoindevkit/bdk-wallet-web'
import type { Bolt11Invoice, Offer, HumanReadableName, RecentPaymentDetails, ChannelDetails, ChannelId } from 'lightningdevkit'
import type { LdkNode } from './init'
import type { SyncNeededCallback } from './traits/event-handler'
import type { PersistedPayment } from './storage/payment-history'

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
      setSyncNeeded: (cb: SyncNeededCallback | undefined) => void
      createInvoice: (description?: string) => string
      sendBolt11Payment: (invoice: Bolt11Invoice, amountMsat?: bigint) => Uint8Array
      sendBolt12Payment: (offer: Offer, amountMsat?: bigint, payerNote?: string) => Uint8Array
      sendBip353Payment: (name: HumanReadableName, amountMsat: bigint) => Uint8Array
      abandonPayment: (paymentId: Uint8Array) => void
      getPaymentResult: (paymentId: Uint8Array) => PaymentResult | null
      listRecentPayments: () => RecentPaymentDetails[]
      /** Real-time outbound capacity in millisatoshis. Use for payment validation. */
      outboundCapacityMsat: () => bigint
      /** Cached outbound capacity in sats, updated every ~10s. Use for balance display. */
      lightningBalanceSats: bigint
      /** Monotonic counter that increments when channel state changes. Use to trigger UI refreshes. */
      channelChangeCounter: number
      /** True once initial peer reconnection has completed and lightning balance is accurate. */
      peersReconnected: boolean
      /** Persisted Lightning payment history (inbound + outbound). */
      paymentHistory: PersistedPayment[]
    }
  | { status: 'error'; node: null; nodeId: null; error: Error }

export const defaultLdkContextValue: LdkContextValue = {
  status: 'loading',
  node: null,
  nodeId: null,
  error: null,
}

export const LdkContext = createContext<LdkContextValue>(defaultLdkContextValue)
