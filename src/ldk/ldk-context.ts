import { createContext } from 'react'
import type { Wallet, EsploraClient } from '@bitcoindevkit/bdk-wallet-web'
import type {
  Bolt11Invoice,
  Offer,
  RecentPaymentDetails,
  ChannelDetails,
  ChannelId,
} from 'lightningdevkit'
import type { LdkNode } from './init'
import type { PersistedPayment } from './storage/payment-history'

export type SyncStatus = 'syncing' | 'synced' | 'stale'

export type VssStatus = 'ok' | 'degraded'

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
      bdkWallet: Wallet
      bdkEsploraClient: EsploraClient
      setSyncNeeded: (cb: (() => void) | undefined) => void
      createInvoice: (amountMsat?: bigint, description?: string) => string
      sendBolt11Payment: (invoice: Bolt11Invoice, amountMsat?: bigint) => Uint8Array
      sendBolt12Payment: (offer: Offer, amountMsat?: bigint, payerNote?: string) => Uint8Array

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
      /** BOLT 12 offer string for receiving payments. Null while loading or if creation failed. */
      bolt12Offer: string | null
      /** VSS backup service status. 'degraded' means writes are failing and Lightning ops are paused. */
      vssStatus: VssStatus
      /** Stop all background tasks and prevent further IDB writes. Used by Restore flow. */
      shutdown: () => void
    }
  | { status: 'error'; node: null; nodeId: null; error: Error }

export const defaultLdkContextValue: LdkContextValue = {
  status: 'loading',
  node: null,
  nodeId: null,
  error: null,
}

export const LdkContext = createContext<LdkContextValue>(defaultLdkContextValue)
