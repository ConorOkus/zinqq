import { useNavigate } from 'react-router'

interface ScreenHeaderProps {
  title: string
  backTo?: string
  onBack?: () => void
  onClose?: () => void
}

export function ScreenHeader({ title, backTo, onBack, onClose }: ScreenHeaderProps) {
  const navigate = useNavigate()

  const handleBack = () => {
    if (onBack) onBack()
    else if (backTo) void navigate(backTo)
  }

  const showBack = backTo || onBack

  return (
    <header className="relative flex h-(--spacing-header) shrink-0 items-center justify-center px-4">
      {showBack && (
        <button
          className="absolute left-4 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full transition-colors hover:bg-white/10"
          onClick={handleBack}
          aria-label="Back"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-6 w-6"
          >
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
        </button>
      )}
      <span className="text-lg font-semibold">{title}</span>
      {onClose && (
        <button
          className="absolute right-4 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full transition-colors hover:bg-white/10"
          onClick={onClose}
          aria-label="Close"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-6 w-6"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </header>
  )
}
