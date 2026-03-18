import { createContext } from 'react'

export type WalletContextValue =
  | { status: 'loading' }
  | {
      status: 'ready'
      ldkSeed: Uint8Array
      bdkDescriptors: { external: string; internal: string }
      vssEncryptionKey: Uint8Array
      vssStoreId: string
    }
  | { status: 'error'; error: Error }

export const defaultWalletContextValue: WalletContextValue = { status: 'loading' }

export const WalletContext = createContext<WalletContextValue>(defaultWalletContextValue)
