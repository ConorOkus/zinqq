import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import type { Wallet } from '@bitcoindevkit/bdk-wallet-web'
import {
  OnchainContext,
  defaultOnchainContextValue,
  type OnchainContextValue,
} from './onchain-context'
import { initializeBdkWallet } from './init'
import { startOnchainSyncLoop, type OnchainBalance } from './sync'
import { useLdk } from '../ldk/use-ldk'

export function OnchainProvider({
  children,
  bdkDescriptors,
}: {
  children: ReactNode
  bdkDescriptors: { external: string; internal: string }
}) {
  const [state, setState] = useState<OnchainContextValue>(defaultOnchainContextValue)
  const walletRef = useRef<Wallet | null>(null)
  const ldk = useLdk()

  // Hold a stable ref to setBdkWallet so it doesn't trigger effect re-runs.
  // The ldk context object changes reference on every LDK state update —
  // depending on it directly would tear down and rebuild BDK on each change.
  const setBdkWalletRef = useRef<((wallet: Wallet | null) => void) | null>(null)
  useEffect(() => {
    setBdkWalletRef.current = ldk.status === 'ready' ? ldk.setBdkWallet : null
  }, [ldk])

  const generateAddress = useCallback((): string => {
    if (!walletRef.current) throw new Error('BDK wallet not initialized')
    const info = walletRef.current.next_unused_address('external')
    return info.address.toString()
  }, [])

  useEffect(() => {
    let cancelled = false
    let syncHandle: { stop: () => void } | null = null

    initializeBdkWallet(bdkDescriptors, 'signet')
      .then(({ wallet, esploraClient }) => {
        if (cancelled) return

        walletRef.current = wallet

        // Register BDK wallet with LDK event handler for channel funding
        setBdkWalletRef.current?.(wallet)

        syncHandle = startOnchainSyncLoop(
          wallet,
          esploraClient,
          (balance: OnchainBalance) => {
            if (cancelled) return
            setState({
              status: 'ready',
              balance,
              wallet,
              generateAddress,
              error: null,
            })
          },
        )
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setState({
          status: 'error',
          balance: null,
          wallet: null,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      })

    return () => {
      cancelled = true
      syncHandle?.stop()
      // Unregister BDK wallet from LDK event handler
      setBdkWalletRef.current?.(null)
      walletRef.current = null
    }
  }, [bdkDescriptors, generateAddress])

  return <OnchainContext value={state}>{children}</OnchainContext>
}
