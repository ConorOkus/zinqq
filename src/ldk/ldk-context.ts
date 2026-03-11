import { createContext } from 'react'
import type { LdkNode } from './init'

export type LdkContextValue =
  | { status: 'loading'; node: null; nodeId: null; error: null }
  | { status: 'ready'; node: LdkNode; nodeId: string; error: null }
  | { status: 'error'; node: null; nodeId: null; error: Error }

export const defaultLdkContextValue: LdkContextValue = {
  status: 'loading',
  node: null,
  nodeId: null,
  error: null,
}

export const LdkContext = createContext<LdkContextValue>(defaultLdkContextValue)
