import { useEffect, useState, type ReactNode } from 'react'
import { initializeLdk } from './init'
import { LdkContext, defaultLdkContextValue, type LdkContextValue } from './ldk-context'

export function LdkProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LdkContextValue>(defaultLdkContextValue)

  useEffect(() => {
    let cancelled = false

    initializeLdk()
      .then((node) => {
        if (!cancelled) {
          setState({ status: 'ready', node, nodeId: node.nodeId, error: null })
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            node: null,
            nodeId: null,
            error: err instanceof Error ? err : new Error(String(err)),
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  return <LdkContext value={state}>{children}</LdkContext>
}
