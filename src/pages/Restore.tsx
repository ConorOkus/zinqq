import { useState } from 'react'
import { ScreenHeader } from '../components/ScreenHeader'
import { useLdk } from '../ldk/use-ldk'
import { validateMnemonic } from '../wallet/mnemonic'
import {
  deriveLdkSeed,
  deriveVssEncryptionKey,
  deriveVssSigningKey,
  deriveVssStoreId,
} from '../wallet/keys'
import { VssClient, SignatureHeaderProvider } from '../ldk/storage/vss-client'
import { LDK_CONFIG } from '../ldk/config'
import { clearAllStores, idbPut } from '../storage/idb'
import { MONITOR_MANIFEST_KEY, parseMonitorManifest } from '../ldk/traits/persist'
import { KNOWN_PEERS_VSS_KEY, parseKnownPeers } from '../ldk/storage/known-peers'
import { captureError } from '../storage/error-log'

type RestoreState =
  | { status: 'input' }
  | { status: 'confirm'; mnemonic: string }
  | { status: 'restoring'; message: string }
  | { status: 'error'; message: string }

export function Restore() {
  const ldk = useLdk()
  const [state, setState] = useState<RestoreState>({ status: 'input' })
  const [words, setWords] = useState<string[]>(Array(12).fill(''))

  const mnemonicString = words.map((w) => w.trim().toLowerCase()).join(' ')
  const isValid = words.every((w) => w.trim().length > 0) && validateMnemonic(mnemonicString)

  const handleWordChange = (index: number, value: string) => {
    // Handle paste of full mnemonic into first field
    const pasted = value.trim().split(/\s+/)
    if (pasted.length === 12) {
      setWords(pasted)
      return
    }
    setWords((prev) => {
      const next = [...prev]
      next[index] = value
      return next
    })
  }

  const handleSubmit = () => {
    if (!isValid) return
    setState({ status: 'confirm', mnemonic: mnemonicString })
  }

  const handleRestore = async () => {
    if (state.status !== 'confirm') return
    const mnemonic = state.mnemonic

    try {
      setState({ status: 'restoring', message: 'Deriving keys...' })

      const ldkSeed = deriveLdkSeed(mnemonic)
      const vssEncryptionKey = deriveVssEncryptionKey(mnemonic)
      const vssSigningKey = deriveVssSigningKey(mnemonic)
      const vssStoreId = await deriveVssStoreId(ldkSeed)

      setState({ status: 'restoring', message: 'Checking backup server...' })

      const vssClient = new VssClient(
        LDK_CONFIG.vssUrl,
        vssStoreId,
        vssEncryptionKey,
        new SignatureHeaderProvider(vssSigningKey)
      )

      // Check if VSS has data for this wallet
      const keys = await vssClient.listKeyVersions()
      if (keys.length === 0) {
        setState({
          status: 'error',
          message:
            'No backup found for this wallet. Make sure you entered the correct seed phrase.',
        })
        return
      }

      setState({ status: 'restoring', message: `Downloading ${keys.length} item(s)...` })

      // Fetch channel_manager
      let cmData: Uint8Array | null = null
      const cmObj = await vssClient.getObject('channel_manager')
      if (cmObj) {
        cmData = cmObj.value
      }

      // Fetch monitors via the _monitor_keys manifest
      const monitors: Array<{ key: string; value: Uint8Array }> = []
      const manifest = await vssClient.getObject(MONITOR_MANIFEST_KEY)
      if (manifest) {
        const monitorKeys = parseMonitorManifest(new TextDecoder().decode(manifest.value))
        for (const key of monitorKeys) {
          const obj = await vssClient.getObject(key)
          if (obj) {
            monitors.push({ key, value: obj.value })
          } else {
            captureError(
              'warning',
              'Restore',
              `Monitor "${key}" listed in manifest but missing from VSS`
            )
          }
        }
      }

      // Fetch known peers
      const peersObj = await vssClient.getObject(KNOWN_PEERS_VSS_KEY)
      let knownPeers: Map<string, { host: string; port: number }> | null = null
      if (peersObj) {
        knownPeers = parseKnownPeers(new TextDecoder().decode(peersObj.value))
      }

      // Stop all LDK background tasks BEFORE clearing IDB.
      // Without this, the running LDK node's persist loop and visibilitychange
      // handler would overwrite the restored data with the old ChannelManager.
      setState({ status: 'restoring', message: 'Stopping wallet...' })
      if (ldk.status === 'ready') {
        ldk.shutdown()
      }
      // Flush microtasks so in-flight async IDB writes from the old node
      // settle before we clear. Without this, a persist that was already
      // awaiting its IDB transaction could land after clearAllStores().
      await new Promise((r) => setTimeout(r, 0))

      setState({ status: 'restoring', message: 'Clearing local data...' })
      await clearAllStores()

      setState({ status: 'restoring', message: 'Writing restored data...' })

      // Write mnemonic first
      await idbPut('wallet_mnemonic', 'primary', mnemonic)

      // Write LDK seed
      await idbPut('ldk_seed', 'primary', ldkSeed)

      // Write BDK descriptors (not stored in IDB — re-derived on startup)

      // Write ChannelManager BEFORE monitors (init.ts requires this order)
      if (cmData) {
        await idbPut('ldk_channel_manager', 'primary', cmData)
      }

      // Write monitors
      for (const monitor of monitors) {
        await idbPut('ldk_channel_monitors', monitor.key, monitor.value)
      }

      // Write known peers
      if (knownPeers) {
        for (const [pubkey, peer] of knownPeers) {
          await idbPut('ldk_known_peers', pubkey, peer)
        }
      }

      setState({ status: 'restoring', message: 'Restarting wallet...' })

      // Full page reload — releases Web Lock, clears WASM state, resets initPromise.
      // No delay needed: LDK background tasks are already stopped by shutdown().
      window.location.href = '/'
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setState({ status: 'error', message: `Restore failed: ${message}` })
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-dark text-on-dark">
      <ScreenHeader title="Recover Wallet" backTo="/settings" />

      <div className="flex flex-1 flex-col px-4 pb-8">
        {state.status === 'input' && (
          <div className="flex flex-1 flex-col gap-4 pt-4">
            <p className="text-sm text-[var(--color-on-dark-muted)]">
              Enter your 12-word recovery phrase to restore your wallet from backup. You can paste
              all 12 words into the first field.
            </p>

            <div className="grid grid-cols-3 gap-2">
              {words.map((word, i) => (
                <div key={i} className="flex items-center gap-1">
                  <span className="w-5 text-right text-xs text-[var(--color-on-dark-muted)]">
                    {i + 1}
                  </span>
                  <input
                    type="text"
                    value={word}
                    onChange={(e) => handleWordChange(i, e.target.value)}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className="w-full rounded-lg bg-dark-elevated px-2 py-2 text-sm text-white outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>
              ))}
            </div>

            <button
              onClick={handleSubmit}
              disabled={!isValid}
              className="mt-4 w-full rounded-xl bg-accent px-6 py-4 font-display font-bold text-white disabled:opacity-40 active:scale-[0.98]"
            >
              Continue
            </button>
          </div>
        )}

        {state.status === 'confirm' && (
          <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-dark-elevated">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-8 w-8 text-amber-400"
              >
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </div>
            <div className="space-y-3">
              <h2 className="font-display text-xl font-bold">
                This will replace your current wallet
              </h2>
              <p className="text-sm text-[var(--color-on-dark-muted)]">
                All existing wallet data will be erased and replaced with the restored wallet. Make
                sure you have backed up your current seed phrase if needed.
              </p>
            </div>
            <div className="flex w-full flex-col gap-3">
              <button
                onClick={() => void handleRestore()}
                className="w-full rounded-xl bg-red-600 px-6 py-4 font-display font-bold text-white active:scale-[0.98]"
              >
                Erase & Restore
              </button>
              <button
                onClick={() => setState({ status: 'input' })}
                className="w-full rounded-xl bg-dark-elevated px-6 py-4 font-display font-bold text-white active:scale-[0.98]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {state.status === 'restoring' && (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            <p className="text-sm text-[var(--color-on-dark-muted)]">{state.message}</p>
          </div>
        )}

        {state.status === 'error' && (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <p className="text-sm text-red-400">{state.message}</p>
            <button
              onClick={() => setState({ status: 'input' })}
              className="rounded-xl bg-dark-elevated px-6 py-3 font-display font-bold text-white active:scale-[0.98]"
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
