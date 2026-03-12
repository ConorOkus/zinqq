import { useContext } from 'react'
import { WalletContext, type WalletContextValue } from './wallet-context'

export function useWallet(): WalletContextValue {
  return useContext(WalletContext)
}
