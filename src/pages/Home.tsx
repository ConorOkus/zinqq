import { useLdk } from '../ldk/use-ldk'

export function Home() {
  const { status, nodeId, error } = useLdk()

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold">Browser Wallet</h1>

      {status === 'loading' && <p className="text-gray-500">Initializing Lightning node...</p>}

      {status === 'ready' && (
        <div className="space-y-1">
          <p className="text-green-600 font-medium">Lightning node ready</p>
          <p className="text-sm text-gray-500 break-all font-mono">Node ID: {nodeId}</p>
        </div>
      )}

      {status === 'error' && (
        <div className="space-y-1">
          <p className="text-red-600 font-medium">Failed to initialize Lightning node</p>
          <p className="text-sm text-red-500">{error.message}</p>
        </div>
      )}
    </div>
  )
}
