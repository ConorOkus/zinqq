import type { PeerManager, ChannelManager } from 'lightningdevkit'
import { connectToPeer, type PeerConnection } from './peer-connection'
import { getKnownPeers } from '../storage/known-peers'
import { bytesToHex } from '../utils'

/**
 * Reconnect channel peers that have dropped. Compares the set of peers
 * with channels against currently connected peers, then reconnects any
 * that are in the known-peers store.
 *
 * Returns the count of successful and failed reconnections.
 */
export async function reconnectDisconnectedPeers(
  channelManager: ChannelManager,
  peerManager: PeerManager,
  activeConnections: Map<string, PeerConnection>
): Promise<{ succeeded: number; failed: number }> {
  const channels = channelManager.list_channels()
  if (channels.length === 0) return { succeeded: 0, failed: 0 }

  // Build set of pubkeys that have channels
  const channelPeerPubkeys = new Set<string>()
  for (const ch of channels) {
    channelPeerPubkeys.add(bytesToHex(ch.get_counterparty().get_node_id()))
  }

  // Build set of currently connected peers
  const connectedPubkeys = new Set<string>()
  for (const peer of peerManager.list_peers()) {
    connectedPubkeys.add(bytesToHex(peer.get_counterparty_node_id()))
  }

  // Find channel peers that are disconnected
  const disconnected = [...channelPeerPubkeys].filter((pk) => !connectedPubkeys.has(pk))
  if (disconnected.length === 0) return { succeeded: 0, failed: 0 }

  console.log(
    `[ldk] ${disconnected.length} channel peer(s) disconnected, attempting reconnect`
  )

  const known = await getKnownPeers()
  const results = await Promise.allSettled(
    disconnected
      .filter((pk) => known.has(pk))
      .map(async (pk) => {
        const { host, port } = known.get(pk)!
        activeConnections.get(pk)?.disconnect()
        const conn = await connectToPeer(peerManager, pk, host, port)
        activeConnections.set(pk, conn)
      })
  )

  const succeeded = results.filter((r) => r.status === 'fulfilled').length
  const failed = results.filter((r) => r.status === 'rejected').length
  if (succeeded > 0 || failed > 0) {
    console.log(`[ldk] peer reconnect: ${succeeded} reconnected, ${failed} failed`)
  }

  return { succeeded, failed }
}
