import { useSyncExternalStore } from 'react'
import type { CloseRecord } from './close-record'
import {
  CLOSE_RECORDS_CHANGED_EVENT,
  getCloseRecordsSnapshot,
  getLastKnownTipHeight,
} from './store'

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener(CLOSE_RECORDS_CHANGED_EVENT, onStoreChange)
  return () => {
    window.removeEventListener(CLOSE_RECORDS_CHANGED_EVENT, onStoreChange)
  }
}

/**
 * Live view of close records. The snapshot reference only changes on real
 * record mutations, so consumers' memo deps stay stable between them.
 * Events are payload-less by contract — this re-reads the store snapshot.
 */
export function useCloseRecords(): readonly CloseRecord[] {
  return useSyncExternalStore(subscribe, getCloseRecordsSnapshot)
}

/** Last tip height observed by reconciliation; null before the first pass. */
export function useLastKnownTipHeight(): number | null {
  return useSyncExternalStore(subscribe, getLastKnownTipHeight)
}
