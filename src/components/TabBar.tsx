import { useLocation, useNavigate } from 'react-router'
import { ScanIcon, MenuIcon } from './icons'

const TAB_BAR_ROUTES = ['/', '/activity']

export function TabBar() {
  const location = useLocation()
  const navigate = useNavigate()

  if (!TAB_BAR_ROUTES.includes(location.pathname)) return null

  const isWallet = location.pathname === '/'
  const isActivity = location.pathname === '/activity'

  return (
    <nav
      className="fixed bottom-0 left-1/2 z-100 flex w-full max-w-[430px] -translate-x-1/2 items-center justify-between bg-accent px-2 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]"
      role="navigation"
      aria-label="Main navigation"
    >
      <button
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-on-accent opacity-40"
        disabled
        aria-label="Scan QR code (coming soon)"
      >
        <ScanIcon className="h-[22px] w-[22px]" />
      </button>

      <button
        className={`flex h-11 w-full max-w-[120px] items-center justify-center rounded-full font-display text-sm font-bold uppercase tracking-wider transition-all ${
          isWallet
            ? 'bg-on-accent text-accent'
            : 'text-[var(--color-on-accent-muted)]'
        }`}
        onClick={() => void navigate('/')}
      >
        Wallet
      </button>

      <button
        className={`flex h-11 w-full max-w-[120px] items-center justify-center rounded-full font-display text-sm font-bold uppercase tracking-wider transition-all ${
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
        <MenuIcon className="h-[22px] w-[22px]" />
      </button>
    </nav>
  )
}
