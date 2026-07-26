import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import QrScanner from 'qr-scanner'
import { classifyPaymentInput } from '../ldk/payment-input'
import { ScreenHeader } from '../components/ScreenHeader'

type ScanError =
  | { kind: 'permission-denied' }
  | { kind: 'not-found' }
  | { kind: 'in-use' }
  | { kind: 'unknown'; message: string }
  | { kind: 'invalid-qr'; message: string }

function errorMessage(error: ScanError): string {
  switch (error.kind) {
    case 'permission-denied':
      return 'Camera access is required to scan QR codes. Please enable it in your browser settings.'
    case 'not-found':
      return 'No camera found on this device.'
    case 'in-use':
      return 'Camera is being used by another app.'
    case 'unknown':
      return error.message
    case 'invalid-qr':
      return error.message
  }
}

function classifyCameraError(err: unknown): ScanError {
  const msg = err instanceof Error ? err.name : String(err)
  if (msg === 'NotAllowedError') return { kind: 'permission-denied' }
  if (msg === 'NotFoundError') return { kind: 'not-found' }
  if (msg === 'NotReadableError') return { kind: 'in-use' }
  return { kind: 'unknown', message: 'Could not access camera' }
}

export function Scan() {
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const hasNavigatedRef = useRef(false)
  const [error, setError] = useState<ScanError | null>(null)

  useEffect(() => {
    const videoEl = videoRef.current
    if (!videoEl) return

    const scanner = new QrScanner(
      videoEl,
      (result) => {
        if (hasNavigatedRef.current) return

        const parsed = classifyPaymentInput(result.data)
        if (parsed.type === 'error') {
          setError({ kind: 'invalid-qr', message: 'Not a valid payment code' })
          return
        }

        hasNavigatedRef.current = true
        scanner.stop()
        void navigate('/send', { state: { scannedInput: result.data } })
      },
      {
        preferredCamera: 'environment',
        highlightScanRegion: false,
        highlightCodeOutline: false,
      }
    )

    scanner.start().catch((err: unknown) => {
      setError(classifyCameraError(err))
    })

    return () => {
      scanner.stop()
      scanner.destroy()
    }
  }, [navigate])

  // Auto-clear invalid-qr errors after 3 seconds
  useEffect(() => {
    if (error?.kind !== 'invalid-qr') return
    const timer = setTimeout(() => setError(null), 3000)
    return () => clearTimeout(timer)
  }, [error])

  const isPersistentError = error !== null && error.kind !== 'invalid-qr'

  return (
    <div className="flex min-h-dvh flex-col bg-black text-on-dark">
      <div className="relative z-10">
        <ScreenHeader title="Scan" onClose={() => void navigate(-1)} />
      </div>

      <div className="relative flex flex-1 items-center justify-center">
        {/* Camera feed */}
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full object-cover"
          autoPlay
          playsInline
          muted
        />

        {/* Viewfinder overlay */}
        {!isPersistentError && (
          <div className="pointer-events-none relative z-10 flex flex-col items-center gap-6">
            {/* Viewfinder frame */}
            <div className="h-64 w-64 rounded-2xl border-2 border-white/60" />
            <p className="text-sm text-white/70">Position the QR Code in view to activate</p>
          </div>
        )}

        {/* Persistent error (permission denied, no camera, in use) */}
        {isPersistentError && (
          <div className="relative z-10 flex flex-col items-center gap-4 px-8 text-center">
            <p className="text-sm text-[var(--color-on-dark-muted)]">{errorMessage(error)}</p>
          </div>
        )}

        {/* Transient error (invalid QR) */}
        {error?.kind === 'invalid-qr' && (
          <div className="absolute bottom-8 left-4 right-4 z-10 rounded-xl bg-danger-strong/90 px-4 py-3 text-center text-sm font-medium text-white">
            {errorMessage(error)}
          </div>
        )}
      </div>
    </div>
  )
}
