import { type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { ChevronBack, XClose } from './icons'

interface ScreenHeaderProps {
  title: string
  backTo?: string
  onBack?: () => void
  onClose?: () => void
  rightAction?: ReactNode
}

export function ScreenHeader({ title, backTo, onBack, onClose, rightAction }: ScreenHeaderProps) {
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
          className="absolute left-4 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full transition-colors hover:bg-on-dark/10"
          onClick={handleBack}
          aria-label="Back"
        >
          <ChevronBack />
        </button>
      )}
      <span className="text-lg font-semibold">{title}</span>
      {rightAction ? (
        <div className="absolute right-4 top-1/2 -translate-y-1/2">{rightAction}</div>
      ) : (
        onClose && (
          <button
            className="absolute right-4 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full transition-colors hover:bg-on-dark/10"
            onClick={onClose}
            aria-label="Close"
          >
            <XClose />
          </button>
        )
      )}
    </header>
  )
}
