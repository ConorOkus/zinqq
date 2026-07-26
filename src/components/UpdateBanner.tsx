import { useEffect, useRef } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'

export function UpdateBanner() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW()
  const intervalRef = useRef<ReturnType<typeof setInterval>>(null)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const reg = navigator.serviceWorker.ready
    void reg.then((registration) => {
      intervalRef.current = setInterval(() => void registration.update(), 60 * 60 * 1000)
    })
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [])

  if (!needRefresh) return null

  return (
    <div className="fixed top-[env(safe-area-inset-top,0px)] left-1/2 z-50 mx-auto flex w-full max-w-xs -translate-x-1/2 items-center justify-between gap-3 rounded-xl bg-dark-elevated px-4 py-3 text-sm text-on-dark shadow-lg">
      <span>New version available</span>
      <button
        className="shrink-0 rounded-lg bg-on-dark/15 px-3 py-1 font-medium transition-colors active:bg-on-dark/25"
        onClick={() => void updateServiceWorker(true)}
      >
        Update
      </button>
    </div>
  )
}
