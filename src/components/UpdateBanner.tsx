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
      intervalRef.current = setInterval(
        () => void registration.update(),
        60 * 60 * 1000
      )
    })
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [])

  if (!needRefresh) return null

  return (
    <div className="mx-auto flex max-w-xs items-center justify-between gap-3 rounded-xl bg-black/20 px-4 py-3 text-sm text-on-accent backdrop-blur-sm">
      <span>New version available</span>
      <button
        className="shrink-0 rounded-lg bg-on-accent/20 px-3 py-1 font-medium transition-colors active:bg-on-accent/30"
        onClick={() => void updateServiceWorker(true)}
      >
        Update
      </button>
    </div>
  )
}
