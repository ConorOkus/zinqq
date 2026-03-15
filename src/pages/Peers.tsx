import { useState, useCallback } from 'react'
import { useLdk } from '../ldk/use-ldk'
import { parsePeerAddress } from '../ldk/peers/peer-connection'
import { ScreenHeader } from '../components/ScreenHeader'

export function Peers() {
  const ldk = useLdk()
  const [peerAddress, setPeerAddress] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [connectedPeers, setConnectedPeers] = useState<string[]>([])

  const refreshPeers = useCallback(() => {
    if (ldk.status !== 'ready') return
    const peers = ldk.node.peerManager.list_peers()
    const pubkeys = peers.map((p) => {
      const bytes = p.get_counterparty_node_id()
      return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    })
    setConnectedPeers(pubkeys)
  }, [ldk])

  const handleConnect = useCallback(async () => {
    if (ldk.status !== 'ready') return
    setConnecting(true)
    setConnectError(null)
    try {
      const { pubkey, host, port } = parsePeerAddress(peerAddress.trim())
      await ldk.connectToPeer(pubkey, host, port)
      setPeerAddress('')
      refreshPeers()
    } catch (err: unknown) {
      setConnectError(err instanceof Error ? err.message : String(err))
    } finally {
      setConnecting(false)
    }
  }, [ldk, peerAddress, refreshPeers])

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
              Connected ({connectedPeers.length})
            </span>
            <button
              className="text-xs text-accent"
              onClick={refreshPeers}
            >
              Refresh
            </button>
          </div>

          {connectedPeers.length === 0 ? (
            <p className="py-4 text-center text-sm text-[var(--color-on-dark-muted)]">
              No peers connected
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {connectedPeers.map((pubkey) => (
                <div
                  key={pubkey}
                  className="flex items-center gap-3 rounded-xl bg-dark-elevated p-4"
                >
                  <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-green-500" />
                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-sm">
                    {pubkey.slice(0, 16)}...{pubkey.slice(-8)}
                  </span>
                  <span className="shrink-0 text-xs font-semibold text-green-500">
                    Connected
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
