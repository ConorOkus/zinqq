import type { ChannelId } from 'lightningdevkit'

/**
 * Shared channel summary type used across pages (Peers, CloseChannel).
 * Field names match the LDK API (outboundCapacityMsat / inboundCapacityMsat).
 */
export interface ChannelInfo {
  channelIdHex: string
  counterpartyPubkey: string
  capacitySats: bigint
  outboundCapacityMsat: bigint
  inboundCapacityMsat: bigint
  isUsable: boolean
  isReady: boolean
}

/**
 * Extended channel info that includes the LDK ChannelId object and raw
 * counterparty node bytes, needed for close-channel operations.
 */
export interface ChannelInfoWithId extends ChannelInfo {
  channelId: ChannelId
  counterpartyNodeId: Uint8Array
}
