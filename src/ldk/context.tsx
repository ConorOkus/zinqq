import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import { initializeLdk, type LdkNode } from './init'
import { LdkContext, defaultLdkContextValue, type LdkContextValue } from './ldk-context'
import { SIGNET_CONFIG } from './config'
import { EsploraClient } from './sync/esplora-client'
import { startSyncLoop } from './sync/chain-sync'
import { connectToPeer as doConnectToPeer } from './peers/peer-connection'

export function LdkProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LdkContextValue>(defaultLdkContextValue)
  const nodeRef = useRef<LdkNode | null>(null)

  const connectToPeer = useCallback(
    async (pubkey: string, host: string, port: number): Promise<void> => {
      if (!nodeRef.current) throw new Error('Node not initialized')
      await doConnectToPeer(nodeRef.current.peerManager, pubkey, host, port)
    },
    []
  )

  useEffect(() => {
    let cancelled = false
    let syncHandle: { stop: () => void } | null = null
    let peerTimerId: ReturnType<typeof setInterval> | null = null

    initializeLdk()
      .then(({ node, watchState }) => {
        if (cancelled) return

        nodeRef.current = node

        const esplora = new EsploraClient(SIGNET_CONFIG.esploraUrl)
        const confirmables = [
          node.channelManager.as_Confirm(),
          node.chainMonitor.as_Confirm(),
        ]

        syncHandle = startSyncLoop(
          confirmables,
          watchState,
          esplora,
          node.channelManager,
          node.chainMonitor,
          node.networkGraph,
          node.scorer,
          SIGNET_CONFIG.chainPollIntervalMs
        )

        // PeerManager timer: ping peers + process events every ~10s
        peerTimerId = setInterval(() => {
          node.peerManager.timer_tick_occurred()
          node.peerManager.process_events()
        }, SIGNET_CONFIG.peerTimerIntervalMs)

        setState({
          status: 'ready',
          node,
          nodeId: node.nodeId,
          error: null,
          syncStatus: 'syncing',
          connectToPeer,
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setState({
          status: 'error',
          node: null,
          nodeId: null,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      })

    return () => {
      cancelled = true
      syncHandle?.stop()
      if (peerTimerId !== null) clearInterval(peerTimerId)
      nodeRef.current = null
    }
  }, [connectToPeer])

  return <LdkContext value={state}>{children}</LdkContext>
}
