import { createContext } from 'react'
import type { LdkNode } from './init'

export type SyncStatus = 'syncing' | 'synced' | 'stale'

export type LdkContextValue =
  | { status: 'loading'; node: null; nodeId: null; error: null }
  | {
      status: 'ready'
      node: LdkNode
      nodeId: string
      error: null
      syncStatus: SyncStatus
      connectToPeer: (pubkey: string, host: string, port: number) => Promise<void>
    }
  | { status: 'error'; node: null; nodeId: null; error: Error }

export const defaultLdkContextValue: LdkContextValue = {
  status: 'loading',
  node: null,
  nodeId: null,
  error: null,
}

export const LdkContext = createContext<LdkContextValue>(defaultLdkContextValue)
