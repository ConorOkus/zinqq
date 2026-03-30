import { ACTIVE_NETWORK } from '../ldk/config'

export function NetworkBadge() {
  if (ACTIVE_NETWORK === 'mainnet') return null

  return (
    <div className="fixed top-0 left-0 right-0 z-50 flex justify-center bg-amber-500/10 py-0.5">
      <span className="text-[10px] font-bold uppercase tracking-wider text-amber-400">
        {ACTIVE_NETWORK}
      </span>
    </div>
  )
}
