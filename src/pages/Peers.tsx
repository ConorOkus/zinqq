import { useState, useCallback, useEffect } from 'react'
import { useLdk } from '../ldk/use-ldk'
import { parsePeerAddress } from '../ldk/peers/peer-connection'
import { getKnownPeers, type KnownPeer } from '../ldk/storage/known-peers'
import { bytesToHex } from '../ldk/utils'
import { ScreenHeader } from '../components/ScreenHeader'

interface PeerEntry {
  pubkey: string
  connected: boolean
  known: boolean
  host?: string
  port?: number
  hasChannels: boolean
}

export function Peers() {
  const ldk = useLdk()
  const [peerAddress, setPeerAddress] = useState('')
  const [connecting, setConnecting] = useState(false)
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

    // Get channels to check which peers have open channels
    const channels = ldk.node.channelManager.list_channels()
    const channelPeerPubkeys = new Set(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- LDK WASM bindings have unresolved types
      channels.map((ch) => bytesToHex(ch.get_counterparty().get_node_id().write() as Uint8Array))
    )

    // Merge: all known peers + any connected peers not in known list
    const allPubkeys = new Set([...knownPeers.keys(), ...connectedPubkeys])
    const entries: PeerEntry[] = Array.from(allPubkeys).map((pubkey) => {
      const known = knownPeers.has(pubkey)
      const peer = knownPeers.get(pubkey)
      return {
        pubkey,
        connected: connectedPubkeys.has(pubkey),
        known,
        host: peer?.host,
        port: peer?.port,
        hasChannels: channelPeerPubkeys.has(pubkey),
      }
    })

    // Sort: connected first, then by pubkey
    entries.sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1
      return a.pubkey.localeCompare(b.pubkey)
    })

    setPeers(entries)
  }, [ldk])

  // Load peers on mount and when ldk becomes ready
  useEffect(() => {
    void refreshPeers()
  }, [refreshPeers])

  const handleConnect = useCallback(async () => {
    if (ldk.status !== 'ready') return
    setConnecting(true)
    setConnectError(null)
    try {
      const { pubkey, host, port } = parsePeerAddress(peerAddress.trim())
      await ldk.connectToPeer(pubkey, host, port)
      setPeerAddress('')
      await refreshPeers()
    } catch (err: unknown) {
      setConnectError(err instanceof Error ? err.message : String(err))
    } finally {
      setConnecting(false)
    }
  }, [ldk, peerAddress, refreshPeers])

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
            Connect to Peer
          </label>
          <input
            id="peer-address"
            type="text"
            value={peerAddress}
            onChange={(e) => setPeerAddress(e.target.value)}
            placeholder="pubkey@host:port"
            className="w-full rounded-xl border border-dark-border bg-dark-elevated px-4 py-3 font-mono text-sm text-on-dark placeholder:text-[var(--color-on-dark-muted)] focus:outline-none focus:ring-2 focus:ring-accent"
            disabled={connecting}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !connecting) void handleConnect()
            }}
          />
          {connectError && (
            <p className="text-sm text-red-400">{connectError}</p>
          )}
          <button
            className="h-12 w-full rounded-xl bg-accent font-display font-bold text-white transition-transform disabled:cursor-not-allowed disabled:opacity-30 active:scale-[0.98]"
            onClick={() => void handleConnect()}
            disabled={connecting || !peerAddress.trim()}
          >
            {connecting ? 'Connecting...' : 'Connect'}
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
                  className="flex items-center gap-3 rounded-xl bg-dark-elevated p-4"
                >
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
                      disabled={peer.hasChannels}
                      title={peer.hasChannels ? 'Cannot forget peer with open channels' : 'Remove from saved peers'}
                    >
                      Forget
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
