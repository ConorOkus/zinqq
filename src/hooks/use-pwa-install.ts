import { useEffect, useRef, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function getIsIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !('MSStream' in window)
}

function getIsStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    ('standalone' in navigator &&
      (navigator as { standalone?: boolean }).standalone === true)
  )
}

export function usePwaInstall() {
  const deferredPrompt = useRef<BeforeInstallPromptEvent | null>(null)
  const [canInstall, setCanInstall] = useState(false)
  const isStandalone = getIsStandalone()
  const [isIos] = useState(() => !getIsStandalone() && getIsIos())

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault()
      deferredPrompt.current = e as BeforeInstallPromptEvent
      setCanInstall(true)
    }

    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const promptInstall = () => {
    const prompt = deferredPrompt.current
    if (!prompt) return
    void prompt
      .prompt()
      .then(({ outcome }) => {
        if (outcome === 'accepted') setCanInstall(false)
        deferredPrompt.current = null
      })
      .catch(() => {
        deferredPrompt.current = null
      })
  }

  return { canInstall, isIos, isStandalone, promptInstall }
}
