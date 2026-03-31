import { useEffect, useState, type ReactNode } from 'react'
import { WalletContext, defaultWalletContextValue, type WalletContextValue } from './wallet-context'
import { generateMnemonic, getMnemonic, storeMnemonic } from './mnemonic'
import {
  deriveLdkSeed,
  deriveBdkDescriptors,
  deriveVssEncryptionKey,
  deriveVssStoreId,
} from './keys'
import { ACTIVE_NETWORK } from '../ldk/config'

// Deduplicate concurrent calls from React StrictMode double-mount.
let walletInitPromise: ReturnType<typeof doInitializeWallet> | null = null

async function doInitializeWallet() {
  let mnemonic = await getMnemonic()
  if (!mnemonic) {
    mnemonic = generateMnemonic()
    await storeMnemonic(mnemonic)
  }
  const ldkSeed = deriveLdkSeed(mnemonic)
  const bdkDescriptors = deriveBdkDescriptors(
    mnemonic,
    ACTIVE_NETWORK === 'mainnet' ? 'bitcoin' : 'signet'
  )
  const vssEncryptionKey = deriveVssEncryptionKey(mnemonic)
  const vssStoreId = await deriveVssStoreId(ldkSeed)
  return { ldkSeed, bdkDescriptors, vssEncryptionKey, vssStoreId }
}

function initializeWallet() {
  if (!walletInitPromise) {
    walletInitPromise = doInitializeWallet().catch((err) => {
      walletInitPromise = null
      throw err
    })
  }
  return walletInitPromise
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WalletContextValue>(defaultWalletContextValue)

  useEffect(() => {
    initializeWallet()
      .then(({ ldkSeed, bdkDescriptors, vssEncryptionKey, vssStoreId }) => {
        walletInitPromise = null // Allow GC of mnemonic closure
        setState({ status: 'ready', ldkSeed, bdkDescriptors, vssEncryptionKey, vssStoreId })
      })
      .catch((err: unknown) => {
        setState({
          status: 'error',
          error: err instanceof Error ? err : new Error(String(err)),
        })
      })
  }, [])

  return <WalletContext value={state}>{children}</WalletContext>
}
