import { useLocation, useNavigate } from 'react-router'

const SUB_FLOW_PREFIXES = ['/send', '/receive', '/settings']

export function TabBar() {
  const location = useLocation()
  const navigate = useNavigate()

  const isSubFlow = SUB_FLOW_PREFIXES.some(
    (prefix) => location.pathname.startsWith(prefix) && location.pathname !== '/',
  )

  if (isSubFlow) return null

  const isWallet = location.pathname === '/'
  const isActivity = location.pathname === '/activity'

  return (
    <nav
      className="fixed bottom-0 left-1/2 z-100 flex w-full max-w-[430px] -translate-x-1/2 items-center justify-evenly bg-accent px-4 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))]"
      role="navigation"
      aria-label="Main navigation"
    >
      <button
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-on-accent"
        onClick={() => alert('Coming soon')}
        aria-label="Scan QR code"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-[22px] w-[22px]"
        >
          <path d="M3 7V5a2 2 0 0 1 2-2h2" />
          <path d="M17 3h2a2 2 0 0 1 2 2v2" />
          <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
          <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
          <rect x="7" y="7" width="10" height="10" rx="1" />
        </svg>
      </button>

      <button
        className={`flex h-11 flex-1 items-center justify-center rounded-full font-display text-sm font-bold uppercase tracking-wider transition-all ${
          isWallet
            ? 'bg-on-accent text-accent'
            : 'text-[var(--color-on-accent-muted)]'
        }`}
        onClick={() => void navigate('/')}
      >
        Wallet
      </button>

      <button
        className={`flex h-11 flex-1 items-center justify-center rounded-full font-display text-sm font-bold uppercase tracking-wider transition-all ${
          isActivity
            ? 'bg-on-accent text-accent'
            : 'text-[var(--color-on-accent-muted)]'
        }`}
        onClick={() => void navigate('/activity')}
      >
        Activity
      </button>

      <button
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-on-accent"
        onClick={() => void navigate('/settings')}
        aria-label="Settings menu"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          className="h-[22px] w-[22px]"
        >
          <line x1="4" y1="6" x2="20" y2="6" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="18" x2="20" y2="18" />
        </svg>
      </button>
    </nav>
  )
}
