import { ArrowRight, BackspaceIcon } from './icons'

export type NumpadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'backspace'

interface NumpadProps {
  onKey: (key: NumpadKey) => void
  onNext: () => void
  nextDisabled: boolean
  nextLabel?: string
}

export function Numpad({ onKey, onNext, nextDisabled, nextLabel = 'Next' }: NumpadProps) {
  return (
    <div className="rounded-t-2xl bg-dark-elevated px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-4">
      <button
        className="mb-4 flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-white font-display text-lg font-bold uppercase tracking-wider text-dark transition-transform disabled:cursor-not-allowed disabled:opacity-30 active:scale-[0.98]"
        onClick={onNext}
        disabled={nextDisabled}
      >
        {nextLabel}
        <ArrowRight className="h-5 w-5" />
      </button>

      <div className="grid grid-cols-3 gap-2">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((key) => (
          <button
            key={key}
            className="flex h-16 select-none items-center justify-center rounded-xl font-display text-2xl font-semibold text-on-dark transition-colors active:bg-white/10"
            onClick={() => onKey(key as NumpadKey)}
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
          <BackspaceIcon className="h-7 w-7 opacity-70" />
        </button>
      </div>
    </div>
  )
}
