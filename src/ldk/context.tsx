import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import { initializeLdk, type LdkNode } from './init'
import { LdkContext, defaultLdkContextValue, type LdkContextValue } from './ldk-context'
import { SIGNET_CONFIG } from './config'
import { EsploraClient } from './sync/esplora-client'
import { startSyncLoop } from './sync/chain-sync'
import { connectToPeer as doConnectToPeer } from './peers/peer-connection'
import { idbPut } from './storage/idb'
import { getKnownPeers, putKnownPeer, deleteKnownPeer } from './storage/known-peers'
import { bytesToHex } from './utils'

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
      putKnownPeer(pubkey, host, port).catch((err: unknown) =>
        console.warn('[ldk] failed to persist known peer:', err)
      )
    },
    []
  )

  const forgetPeer = useCallback(async (pubkey: string): Promise<void> => {
    const node = nodeRef.current
    if (!node) throw new Error('Node not initialized')

    const channels = node.channelManager.list_channels()
    const hasChannels = channels.some((ch) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- LDK WASM bindings have unresolved types
      const counterparty = bytesToHex(ch.get_counterparty().get_node_id().write() as Uint8Array)
      return counterparty === pubkey
    })

    if (hasChannels) {
      throw new Error('Cannot forget peer with open channels')
    }

    await deleteKnownPeer(pubkey)
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
          forgetPeer,
          setBdkWallet,
        })

        // Auto-reconnect to known peers (fire-and-forget, non-blocking)
        getKnownPeers()
          .then(async (peers) => {
            if (peers.size === 0) return
            console.log(`[ldk] reconnecting to ${peers.size} known peer(s)`)
            const results = await Promise.allSettled(
              Array.from(peers.entries()).map(([pubkey, { host, port }]) =>
                doConnectToPeer(node.peerManager, pubkey, host, port)
              )
            )
            const succeeded = results.filter((r) => r.status === 'fulfilled').length
            const failed = results.filter((r) => r.status === 'rejected').length
            console.log(`[ldk] peer reconnection: ${succeeded} connected, ${failed} failed`)
          })
          .catch((err: unknown) => {
            console.warn('[ldk] failed to read known peers:', err)
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
  }, [connectToPeer, forgetPeer, ldkSeed])

  return <LdkContext value={state}>{children}</LdkContext>
}
