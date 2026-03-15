import { BackspaceIcon } from './icons.tsx'

export type NumpadKey =
  | '0'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | 'backspace'

interface NumpadProps {
  onKey: (key: NumpadKey) => void
}

const KEYS: (NumpadKey | null)[] = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  null,
  '0',
  'backspace',
]

export function Numpad({ onKey }: NumpadProps) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {KEYS.map((key, i) =>
        key === null ? (
          <div key="spacer" />
        ) : (
          <button
            key={key}
            type="button"
            onClick={() => onKey(key)}
            className="flex items-center justify-center h-16 rounded-lg text-xl font-medium select-none active:bg-gray-200 dark:active:bg-gray-700"
            aria-label={key === 'backspace' ? 'Delete' : key}
          >
            {key === 'backspace' ? (
              <BackspaceIcon className="w-7 h-7 opacity-70" />
            ) : (
              key
            )}
          </button>
        ),
      )}
    </div>
  )
}
