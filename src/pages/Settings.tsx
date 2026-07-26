import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ScreenHeader } from '../components/ScreenHeader'
import { getStoredTheme, setTheme, THEME_MODES, type ThemeMode } from '../utils/theme'

const THEME_LABELS: Record<ThemeMode, string> = {
  hybrid: 'Hybrid',
  light: 'Light',
  dark: 'Dark',
}

const SETTINGS_ITEMS = [
  {
    label: 'Wallet Backup',
    detail: 'Setup',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-[22px] w-[22px]"
      >
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    ),
    route: '/settings/backup',
  },
  {
    label: 'Recover Wallet',
    detail: 'From Seed',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-[22px] w-[22px]"
      >
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    ),
    route: '/settings/restore',
  },
  {
    label: 'Advanced',
    detail: 'Settings',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-[22px] w-[22px]"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
    route: '/settings/advanced',
  },
  {
    label: 'How It Works',
    detail: 'FAQ',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-[22px] w-[22px]"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    ),
    route: null,
  },
  {
    label: 'Get Help',
    detail: 'Chat with us',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-[22px] w-[22px]"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
    route: null,
  },
]

export function Settings() {
  const navigate = useNavigate()
  const [theme, setThemeState] = useState<ThemeMode>(getStoredTheme)

  const selectTheme = (mode: ThemeMode) => {
    setTheme(mode)
    setThemeState(mode)
  }

  return (
    <div className="flex min-h-dvh flex-col bg-dark text-on-dark">
      <ScreenHeader title="Settings" backTo="/" />
      <div className="p-4">
        {SETTINGS_ITEMS.map((item) => (
          <button
            key={item.label}
            className="flex w-full items-center gap-4 rounded-xl px-2 py-4 transition-colors active:bg-dark-elevated"
            onClick={() => {
              if (item.route) void navigate(item.route)
            }}
          >
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-dark-elevated text-[var(--color-on-dark-muted)]">
              {item.icon}
            </div>
            <span className="flex-1 text-left font-semibold">{item.label}</span>
            <span className="text-sm text-[var(--color-on-dark-muted)]">{item.detail}</span>
          </button>
        ))}

        <div className="mt-2 px-2 py-4">
          <span className="font-semibold">Appearance</span>
          <div
            className="mt-3 flex gap-1.5 rounded-xl bg-dark-elevated p-1"
            role="radiogroup"
            aria-label="Appearance"
          >
            {THEME_MODES.map((mode) => (
              <button
                key={mode}
                role="radio"
                aria-checked={theme === mode}
                className={`h-10 flex-1 rounded-lg text-sm font-semibold transition-colors ${
                  theme === mode
                    ? 'bg-on-dark text-dark'
                    : 'text-[var(--color-on-dark-muted)] active:bg-on-dark/10'
                }`}
                onClick={() => selectTheme(mode)}
              >
                {THEME_LABELS[mode]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
