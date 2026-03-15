import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import { initializeLdk, type LdkNode } from './init'
import { LdkContext, defaultLdkContextValue, type LdkContextValue } from './ldk-context'
import { SIGNET_CONFIG } from './config'
import { EsploraClient } from './sync/esplora-client'
import { startSyncLoop } from './sync/chain-sync'
import { connectToPeer as doConnectToPeer } from './peers/peer-connection'
import { idbPut } from './storage/idb'

export function LdkProvider({
  children,
  ldkSeed,
}: {
  children: ReactNode
  ldkSeed: Uint8Array
}) {
  const [state, setState] = useState<LdkContextValue>(defaultLdkContextValue)
  const nodeRef = useRef<LdkNode | null>(null)

  const connectToPeer = useCallback(
    async (pubkey: string, host: string, port: number): Promise<void> => {
      if (!nodeRef.current) throw new Error('Node not initialized')
      await doConnectToPeer(nodeRef.current.peerManager, pubkey, host, port)
    },
    []
  )

  const listPeers = useCallback((): string[] => {
    if (!nodeRef.current) return []
    const peers = nodeRef.current.peerManager.list_peers()
    return peers.map((p) => {
      const bytes = p.get_counterparty_node_id()
      return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    let syncHandle: { stop: () => void } | null = null
    let peerTimerId: ReturnType<typeof setInterval> | null = null
    let cleanupEventHandlerFn: (() => void) | null = null

    initializeLdk(ldkSeed)
      .then(({ node, watchState, cleanupEventHandler, setBdkWallet }) => {
        if (cancelled) return

        nodeRef.current = node
        cleanupEventHandlerFn = cleanupEventHandler

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

        // PeerManager timer + LDK event processing every ~10s
        peerTimerId = setInterval(() => {
          node.peerManager.timer_tick_occurred()
          node.peerManager.process_events()

          // Drain LDK events from both ChannelManager and ChainMonitor
          node.channelManager
            .as_EventsProvider()
            .process_pending_events(node.eventHandler)
          node.chainMonitor
            .as_EventsProvider()
            .process_pending_events(node.eventHandler)

          // Flush ChannelManager state immediately after processing events
          if (node.channelManager.get_and_clear_needs_persistence()) {
            const data = node.channelManager.write()
            void idbPut('ldk_channel_manager', 'primary', data).catch(
              (err: unknown) => {
                console.error(
                  '[LDK Context] Failed to persist ChannelManager after events:',
                  err,
                )
              },
            )
          }
        }, SIGNET_CONFIG.peerTimerIntervalMs)

        setState({
          status: 'ready',
          node,
          nodeId: node.nodeId,
          error: null,
          syncStatus: 'syncing',
          connectToPeer,
          listPeers,
          setBdkWallet,
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
      cleanupEventHandlerFn?.()
      if (peerTimerId !== null) clearInterval(peerTimerId)
      nodeRef.current = null
    }
  }, [connectToPeer, listPeers, ldkSeed])

  return <LdkContext value={state}>{children}</LdkContext>
}
