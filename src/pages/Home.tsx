import { useState, useCallback } from 'react'
import { Link } from 'react-router'
import { useLdk } from '../ldk/use-ldk'
import { useOnchain } from '../onchain/use-onchain'
import { parsePeerAddress } from '../ldk/peers/peer-connection'

export function Home() {
  const ldk = useLdk()
  const onchain = useOnchain()
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

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Browser Wallet</h1>

      {onchain.status === 'ready' && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">On-chain Balance</h2>
          <p className="text-2xl font-bold">
            {onchain.balance.confirmed.toString()} sats
          </p>
          {onchain.balance.trustedPending + onchain.balance.untrustedPending > 0n && (
            <p className="text-sm text-gray-500">
              +{(onchain.balance.trustedPending + onchain.balance.untrustedPending).toString()} sats pending
            </p>
          )}
          <Link
            to="/receive"
            className="inline-block px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700"
          >
            Receive
          </Link>
        </div>
      )}

      {onchain.status === 'loading' && (
        <p className="text-gray-500">Loading on-chain wallet...</p>
      )}

      {onchain.status === 'error' && (
        <p className="text-sm text-red-500">On-chain wallet error: {onchain.error.message}</p>
      )}

      {ldk.status === 'loading' && (
        <p className="text-gray-500">Initializing Lightning node...</p>
      )}

      {ldk.status === 'ready' && (
        <>
          <div className="space-y-1">
            <p className="text-green-600 font-medium">Lightning node ready</p>
            <p className="text-sm text-gray-500 break-all font-mono">
              Node ID: {ldk.nodeId}
            </p>
          </div>

          <div className="space-y-3">
            <h2 className="text-lg font-semibold">Connect to Peer</h2>
            <div className="flex gap-2">
              <input
                type="text"
                value={peerAddress}
                onChange={(e) => setPeerAddress(e.target.value)}
                placeholder="pubkey@host:port"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={connecting}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !connecting) void handleConnect()
                }}
              />
              <button
                onClick={() => void handleConnect()}
                disabled={connecting || !peerAddress.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-700"
              >
                {connecting ? 'Connecting...' : 'Connect'}
              </button>
            </div>
            {connectError && (
              <p className="text-sm text-red-500">{connectError}</p>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">
                Connected Peers ({connectedPeers.length})
              </h2>
              <button
                onClick={refreshPeers}
                className="text-xs text-blue-600 hover:underline"
              >
                Refresh
              </button>
            </div>
            {connectedPeers.length === 0 ? (
              <p className="text-sm text-gray-400">No peers connected</p>
            ) : (
              <ul className="space-y-1">
                {connectedPeers.map((pubkey) => (
                  <li
                    key={pubkey}
                    className="text-sm font-mono text-gray-600 break-all"
                  >
                    {pubkey}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {ldk.status === 'error' && (
        <div className="space-y-1">
          <p className="text-red-600 font-medium">
            Failed to initialize Lightning node
          </p>
          <p className="text-sm text-red-500">{ldk.error.message}</p>
        </div>
      )}
    </div>
  )
}
