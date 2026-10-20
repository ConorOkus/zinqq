import { useSyncExternalStore } from 'react'
import { getStableSnapshot, subscribeStable } from './runtime'

export function useStableBalance() {
  return useSyncExternalStore(subscribeStable, getStableSnapshot, getStableSnapshot)
}
