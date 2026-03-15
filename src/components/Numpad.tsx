export type NumpadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'backspace'

interface NumpadProps {
  onKey: (key: NumpadKey) => void
  onNext: () => void
  nextDisabled: boolean
}

export function Numpad({ onKey, onNext, nextDisabled }: NumpadProps) {
  return (
    <div className="rounded-t-2xl bg-dark-elevated px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-4">
      <button
        className="mb-4 flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-white font-display text-lg font-bold uppercase tracking-wider text-dark transition-transform disabled:cursor-not-allowed disabled:opacity-30 active:scale-[0.98]"
        onClick={onNext}
        disabled={nextDisabled}
      >
        Next
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5"
        >
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </button>

      <div className="grid grid-cols-3 gap-2">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((key) => (
          <button
            key={key}
            className="flex h-16 select-none items-center justify-center rounded-xl font-display text-2xl font-semibold text-on-dark transition-colors active:bg-white/10"
            onClick={() => onKey(key)}
            aria-label={key}
          >
            {key}
          </button>
        ))}
        <div aria-hidden="true" />
        <button
          className="flex h-16 select-none items-center justify-center rounded-xl font-display text-2xl font-semibold text-on-dark transition-colors active:bg-white/10"
          onClick={() => onKey('0')}
          aria-label="0"
        >
          0
        </button>
        <button
          className="flex h-16 select-none items-center justify-center rounded-xl text-on-dark transition-colors active:bg-white/10"
          onClick={() => onKey('backspace')}
          aria-label="Delete"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-7 w-7 opacity-70"
          >
            <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" />
            <line x1="18" y1="9" x2="12" y2="15" />
            <line x1="12" y1="9" x2="18" y2="15" />
          </svg>
        </button>
      </div>
    </div>
  )
}
