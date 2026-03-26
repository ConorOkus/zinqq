import { type ReactNode } from 'react'
import { useWallet } from './use-wallet'
import { LdkProvider } from '../ldk/context'
import { OnchainProvider } from '../onchain/context'

export function WalletGate({ children }: { children: ReactNode }) {
  const wallet = useWallet()

  if (wallet.status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center text-gray-400">
        Loading wallet...
      </div>
    )
  }

  if (wallet.status === 'error') {
    return <div className="p-4 text-red-400">Wallet error: {wallet.error.message}</div>
  }

  // status === 'ready' — render providers with derived keys, then children
  return (
    <LdkProvider
      ldkSeed={wallet.ldkSeed}
      bdkDescriptors={wallet.bdkDescriptors}
      vssEncryptionKey={wallet.vssEncryptionKey}
      vssStoreId={wallet.vssStoreId}
    >
      <OnchainProvider>{children}</OnchainProvider>
    </LdkProvider>
  )
}
