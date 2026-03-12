import { type ReactNode } from 'react'
import { useWallet } from './use-wallet'
import { LdkProvider } from '../ldk/context'

export function WalletGate({ children }: { children: ReactNode }) {
  const wallet = useWallet()

  if (wallet.status === 'loading') {
    return <div className="p-4 text-gray-400">Loading wallet...</div>
  }

  if (wallet.status === 'new') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="max-w-md space-y-4 text-center">
          <h1 className="text-2xl font-bold">Welcome</h1>
          <p className="text-gray-400">Create a new wallet or import an existing one.</p>
          <div className="flex gap-4 justify-center">
            <button
              onClick={wallet.createWallet}
              className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
            >
              Create Wallet
            </button>
            <button
              onClick={() => {
                const mnemonic = prompt('Enter your 12-word mnemonic:')
                if (mnemonic) wallet.importWallet(mnemonic)
              }}
              className="rounded border border-gray-600 px-4 py-2 text-gray-300 hover:bg-gray-800"
            >
              Import Wallet
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (wallet.status === 'backup') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="max-w-md space-y-4 text-center">
          <h1 className="text-2xl font-bold">Back Up Your Mnemonic</h1>
          <p className="text-gray-400">
            Write down these 12 words in order. They are the only way to recover your wallet.
          </p>
          <div className="rounded bg-gray-800 p-4 font-mono text-sm">
            {wallet.mnemonic.split(' ').map((word, i) => (
              <span key={i} className="mr-3 inline-block">
                <span className="text-gray-500">{i + 1}.</span> {word}
              </span>
            ))}
          </div>
          <button
            onClick={() => void wallet.confirmBackup()}
            className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
          >
            I've Written It Down
          </button>
        </div>
      </div>
    )
  }

  if (wallet.status === 'error') {
    return (
      <div className="p-4 text-red-400">
        Wallet error: {wallet.error.message}
      </div>
    )
  }

  // status === 'ready' — render LdkProvider with derived seed, then children
  return (
    <LdkProvider ldkSeed={wallet.ldkSeed}>
      {children}
    </LdkProvider>
  )
}
