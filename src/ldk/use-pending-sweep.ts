import { useState, useEffect } from 'react'
import { getPendingSweepInfo, SWEEP_STATE_EVENT, type PendingSweepInfo } from './sweep'
import { captureError } from '../storage/error-log'

/**
 * React hook exposing outputs that are still waiting to sweep (e.g. dust or
 * timelocked at current fee rates). Reads on mount and re-reads whenever a
 * sweep attempt changes the pending state.
 */
export function usePendingSweep(): PendingSweepInfo | null {
  const [info, setInfo] = useState<PendingSweepInfo | null>(null)

  useEffect(() => {
    const load = () => {
      getPendingSweepInfo()
        .then(setInfo)
        .catch((err: unknown) =>
          captureError('error', 'usePendingSweep', 'Failed to load pending sweep info', String(err))
        )
    }

    load()
    window.addEventListener(SWEEP_STATE_EVENT, load)
    return () => window.removeEventListener(SWEEP_STATE_EVENT, load)
  }, [])

  return info
}
