import { useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { useLdk } from '../ldk/use-ldk'
import { parsePeerAddress } from '../ldk/peers/peer-connection'
import { getKnownPeers, type KnownPeer } from '../ldk/storage/known-peers'
import { bytesToHex } from '../ldk/utils'
import { formatBtc } from '../utils/format-btc'
import { ScreenHeader } from '../components/ScreenHeader'
import type { ChannelInfo } from '../ldk/types'

interface PeerEntry {
  pubkey: string
  connected: boolean
  known: boolean
  host?: string
  port?: number
  channels: ChannelInfo[]
}

export function Peers() {
  const navigate = useNavigate()
  const ldk = useLdk()
  const [peerAddress, setPeerAddress] = useState('')
  const [connectError, setConnectError] = useState<string | null>(null)
  const [peers, setPeers] = useState<PeerEntry[]>([])
  const [forgetError, setForgetError] = useState<string | null>(null)

  const refreshPeers = useCallback(async () => {
    if (ldk.status !== 'ready') return

    // Get connected peers from PeerManager
    const connectedList = ldk.node.peerManager.list_peers()
    const connectedPubkeys = new Set(
      connectedList.map((p) => bytesToHex(p.get_counterparty_node_id()))
    )

    // Get known peers from IndexedDB
    let knownPeers: Map<string, KnownPeer>
    try {
      knownPeers = await getKnownPeers()
    } catch {
      knownPeers = new Map()
    }

    // Get channels grouped by peer pubkey
    const channels = ldk.node.channelManager.list_channels()
    const channelsByPeer = new Map<string, ChannelInfo[]>()
    for (const ch of channels) {
      const counterparty = ch.get_counterparty()
      const peerPubkey = bytesToHex(counterparty.get_node_id())
      const info: ChannelInfo = {
        channelIdHex: bytesToHex(ch.get_channel_id().write()),
        counterpartyPubkey: peerPubkey,
        capacitySats: ch.get_channel_value_satoshis(),
        outboundCapacityMsat: ch.get_outbound_capacity_msat(),
        inboundCapacityMsat: ch.get_inbound_capacity_msat(),
        isUsable: ch.get_is_usable(),
        isReady: ch.get_is_channel_ready(),
      }
      const existing = channelsByPeer.get(peerPubkey)
      if (existing) {
        existing.push(info)
      } else {
        channelsByPeer.set(peerPubkey, [info])
      }
    }

    // Merge: all known peers + any connected peers not in known list
    const allPubkeys = new Set([...knownPeers.keys(), ...connectedPubkeys])
    const entries: PeerEntry[] = Array.from(allPubkeys).map((pubkey) => {
      const known = knownPeers.has(pubkey)
      const peer = knownPeers.get(pubkey)
      const peerChannels = channelsByPeer.get(pubkey) ?? []
      return {
        pubkey,
        connected: connectedPubkeys.has(pubkey),
        known,
        host: peer?.host,
        port: peer?.port,
        channels: peerChannels,
      }
    })

    // Sort: connected first, then by pubkey
    entries.sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1
      return a.pubkey.localeCompare(b.pubkey)
    })

    setPeers(entries)
  }, [ldk.status]) // eslint-disable-line react-hooks/exhaustive-deps -- only re-run when status changes, not on every context object change

  // Refresh peers on mount, when ldk becomes ready, and when channel state changes
  const channelChangeCounter = ldk.status === 'ready' ? ldk.channelChangeCounter : 0
  useEffect(() => {
    void refreshPeers()
  }, [refreshPeers, channelChangeCounter])

  const handleConnect = useCallback(() => {
    setConnectError(null)
    try {
      const { pubkey, host, port } = parsePeerAddress(peerAddress.trim())
      void navigate('/settings/advanced/peers/open-channel', {
        state: { peerPubkey: pubkey, peerHost: host, peerPort: port },
      })
    } catch (err: unknown) {
      setConnectError(err instanceof Error ? err.message : String(err))
    }
  }, [peerAddress, navigate])

  const handleForget = useCallback(
    async (pubkey: string) => {
      if (ldk.status !== 'ready') return
      setForgetError(null)
      try {
        await ldk.forgetPeer(pubkey)
        await refreshPeers()
      } catch (err: unknown) {
        setForgetError(err instanceof Error ? err.message : String(err))
      }
    },
    [ldk, refreshPeers]
  )

  if (ldk.status === 'loading') {
    return (
      <div className="flex min-h-dvh flex-col bg-dark text-on-dark">
        <ScreenHeader title="Peers" backTo="/settings/advanced" />
        <div className="flex flex-1 items-center justify-center">
          <p className="text-[var(--color-on-dark-muted)]">Loading Lightning node...</p>
        </div>
      </div>
    )
  }

  if (ldk.status === 'error') {
    return (
      <div className="flex min-h-dvh flex-col bg-dark text-on-dark">
        <ScreenHeader title="Peers" backTo="/settings/advanced" />
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6">
          <p className="font-semibold text-on-dark">Lightning node error</p>
          <p className="text-sm text-red-400">{ldk.error.message}</p>
        </div>
      </div>
    )
  }

  const connectedCount = peers.filter((p) => p.connected).length

  return (
    <div className="flex min-h-dvh flex-col bg-dark text-on-dark">
      <ScreenHeader title="Peers" backTo="/settings/advanced" />

      <div className="flex flex-col gap-5 px-6 pt-2">
        {/* Connect form */}
        <div className="flex flex-col gap-2">
          <label htmlFor="peer-address" className="text-sm font-medium text-[var(--color-on-dark-muted)]">
            Connect & Open Channel
          </label>
          <input
            id="peer-address"
            type="text"
            value={peerAddress}
            onChange={(e) => setPeerAddress(e.target.value)}
            placeholder="pubkey@host:port"
            className="w-full rounded-xl border border-dark-border bg-dark-elevated px-4 py-3 font-mono text-sm text-on-dark placeholder:text-[var(--color-on-dark-muted)] focus:outline-none focus:ring-2 focus:ring-accent"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleConnect()
            }}
          />
          {connectError && (
            <p className="text-sm text-red-400">{connectError}</p>
          )}
          <button
            className="h-12 w-full rounded-xl bg-accent font-display font-bold text-white transition-transform disabled:cursor-not-allowed disabled:opacity-30 active:scale-[0.98]"
            onClick={handleConnect}
            disabled={!peerAddress.trim()}
          >
            Next
          </button>
        </div>

        {/* Peer list */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">
              Peers ({connectedCount} connected, {peers.length} saved)
            </span>
            <button
              className="text-xs text-accent"
              onClick={() => void refreshPeers()}
            >
              Refresh
            </button>
          </div>

          {forgetError && (
            <p className="text-sm text-red-400">{forgetError}</p>
          )}

          {peers.length === 0 ? (
            <p className="py-4 text-center text-sm text-[var(--color-on-dark-muted)]">
              No peers connected
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {peers.map((peer) => (
                <div
                  key={peer.pubkey}
                  className="flex flex-col gap-2 rounded-xl bg-dark-elevated p-4"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                        peer.connected ? 'bg-green-500' : 'bg-gray-500'
                      }`}
                    />
                    <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-sm">
                      {peer.pubkey.slice(0, 16)}...{peer.pubkey.slice(-8)}
                    </span>
                    <span
                      className={`shrink-0 text-xs font-semibold ${
                        peer.connected ? 'text-green-500' : 'text-[var(--color-on-dark-muted)]'
                      }`}
                    >
                      {peer.connected ? 'Connected' : 'Offline'}
                    </span>
                    {peer.known && (
                      <button
                        className="shrink-0 text-xs text-red-400 disabled:opacity-30"
                        onClick={() => void handleForget(peer.pubkey)}
                        disabled={peer.channels.length > 0}
                        title={peer.channels.length > 0 ? 'Cannot forget peer with open channels' : 'Remove from saved peers'}
                      >
                        Forget
                      </button>
                    )}
                  </div>
                  {peer.channels.map((ch) => (
                    <div key={ch.channelIdHex} className="ml-5 flex flex-col gap-1 border-l border-dark-border pl-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-[var(--color-on-dark-muted)]">
                          {ch.isUsable ? 'Active' : ch.isReady ? 'Ready' : 'Pending'}
                        </span>
                        <span className="text-xs font-semibold">
                          {formatBtc(ch.capacitySats)} capacity
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3 text-xs text-[var(--color-on-dark-muted)]">
                        <div className="flex gap-3">
                          <span>Send: {formatBtc(ch.outboundCapacityMsat / 1000n)}</span>
                          <span>Receive: {formatBtc(ch.inboundCapacityMsat / 1000n)}</span>
                        </div>
                        <button
                          className="shrink-0 text-xs font-semibold text-red-400 transition-colors active:text-red-300"
                          onClick={() => void navigate('/settings/advanced/peers/close-channel', {
                            state: { channelIdHex: ch.channelIdHex, counterpartyPubkey: ch.counterpartyPubkey },
                          })}
                        >
                          Close
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
