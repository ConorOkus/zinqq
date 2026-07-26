export type ThemeMode = 'hybrid' | 'light' | 'dark'

export const THEME_MODES: ThemeMode[] = ['hybrid', 'light', 'dark']
export const DEFAULT_THEME: ThemeMode = 'hybrid'

const STORAGE_KEY = 'theme'

/** Browser chrome color per mode — matches --color-field in index.css. */
const THEME_COLORS: Record<ThemeMode, string> = {
  hybrid: '#E4D7BE',
  light: '#F6F1E5',
  dark: '#12100C',
}

export function getStoredTheme(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'hybrid' || value === 'light' || value === 'dark') return value
  } catch {
    // localStorage unavailable
  }
  return DEFAULT_THEME
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta) meta.content = THEME_COLORS[mode]
}

export function setTheme(mode: ThemeMode): void {
  applyTheme(mode)
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // localStorage unavailable
  }
}
