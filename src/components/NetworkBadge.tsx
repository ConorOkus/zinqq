import { ACTIVE_NETWORK } from '../ldk/config'

export function NetworkBadge() {
  if (ACTIVE_NETWORK === 'mainnet') return null

  return (
    <div className="flex justify-center bg-amber-500/10 py-1">
      <span className="text-xs font-bold uppercase tracking-wider text-amber-400">
        {ACTIVE_NETWORK}
      </span>
    </div>
  )
}
