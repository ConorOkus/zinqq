import { useEffect, useState, useCallback, type ReactNode } from 'react'
import { WalletContext, defaultWalletContextValue, type WalletContextValue } from './wallet-context'
import { generateMnemonic, validateMnemonic, getMnemonic, storeMnemonic } from './mnemonic'
import { deriveLdkSeed, deriveBdkDescriptors } from './keys'

export function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WalletContextValue>(defaultWalletContextValue)

  const setReady = useCallback((mnemonic: string) => {
    const ldkSeed = deriveLdkSeed(mnemonic)
    const bdkDescriptors = deriveBdkDescriptors(mnemonic, 'signet')
    setState({ status: 'ready', ldkSeed, bdkDescriptors })
  }, [])

  const createWallet = useCallback(() => {
    const mnemonic = generateMnemonic()
    setState({
      status: 'backup',
      mnemonic,
      confirmBackup: async () => {
        await storeMnemonic(mnemonic)
        setReady(mnemonic)
      },
    })
  }, [setReady])

  const importWallet = useCallback(
    (raw: string) => {
      const mnemonic = raw.trim().toLowerCase().replace(/\s+/g, ' ')
      if (!validateMnemonic(mnemonic)) {
        setState({ status: 'error', error: new Error('Invalid mnemonic') })
        return
      }
      void storeMnemonic(mnemonic)
        .then(() => setReady(mnemonic))
        .catch((err: unknown) => {
          setState({
            status: 'error',
            error: err instanceof Error ? err : new Error(String(err)),
          })
        })
    },
    [setReady],
  )

  useEffect(() => {
    getMnemonic()
      .then((existing) => {
        if (existing) {
          setReady(existing)
        } else {
          setState({ status: 'new', createWallet, importWallet })
        }
      })
      .catch((err: unknown) => {
        setState({
          status: 'error',
          error: err instanceof Error ? err : new Error(String(err)),
        })
      })
  }, [createWallet, importWallet, setReady])

  return <WalletContext value={state}>{children}</WalletContext>
}
