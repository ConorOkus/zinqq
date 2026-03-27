import type { NumpadKey } from './Numpad'

const DEFAULT_MAX_DIGITS = 8

/** Shared reducer for numpad digit entry with backspace, max-digits, and leading-zero handling. */
export function numpadDigitReducer(
  prev: string,
  key: NumpadKey,
  maxDigits = DEFAULT_MAX_DIGITS
): string {
  if (key === 'backspace') return prev.slice(0, -1)
  if (prev.length >= maxDigits) return prev
  if (prev === '0' && key === '0') return prev
  if (prev === '' && key === '0') return '0'
  if (prev === '0') return key
  return prev + key
}
