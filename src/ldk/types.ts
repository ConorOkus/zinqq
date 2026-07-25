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
  /**
   * The channel reserve the counterparty requires us to hold
   * (`unspendable_punishment_reserve`) — balance we can see but not spend.
   * Null when LDK hasn't determined it yet (pre-funding). 0 means a
   * zero-reserve channel.
   */
  reserveSats: bigint | null
  /**
   * True when a cooperative close was initiated but hasn't completed
   * (shutdown state ≠ NotShuttingDown). LDK never auto-falls-back to a
   * force close, so a stalled coop close sits here indefinitely — the UI
   * surfaces it and offers "Force close instead".
   */
  isShuttingDown: boolean
}

/**
 * Extended channel info that includes the LDK ChannelId object and raw
 * counterparty node bytes, needed for close-channel operations.
 */
export interface ChannelInfoWithId extends ChannelInfo {
  channelId: ChannelId
  counterpartyNodeId: Uint8Array
}
