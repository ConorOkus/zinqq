import { createContext } from 'react'

export type WalletContextValue =
  | { status: 'loading' }
  | { status: 'new'; createWallet: () => void; importWallet: (mnemonic: string) => void }
  | { status: 'backup'; mnemonic: string; confirmBackup: () => Promise<void> }
  | {
      status: 'ready'
      ldkSeed: Uint8Array
      bdkDescriptors: { external: string; internal: string }
    }
  | { status: 'error'; error: Error }

export const defaultWalletContextValue: WalletContextValue = { status: 'loading' }

export const WalletContext = createContext<WalletContextValue>(defaultWalletContextValue)
