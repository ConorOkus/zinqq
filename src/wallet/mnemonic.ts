import {
  generateMnemonic as generateBip39Mnemonic,
  validateMnemonic as validateBip39Mnemonic,
} from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { idbGet, openDb } from '../storage/idb'

const MNEMONIC_KEY = 'primary'

export function generateMnemonic(): string {
  return generateBip39Mnemonic(wordlist, 128)
}

export function validateMnemonic(mnemonic: string): boolean {
  return validateBip39Mnemonic(mnemonic, wordlist)
}

export async function getMnemonic(): Promise<string | undefined> {
  return idbGet<string>('wallet_mnemonic', MNEMONIC_KEY)
}

// Atomic check-and-write in a single readwrite transaction to prevent TOCTOU
// race across tabs. Throws if a mnemonic already exists.
export async function storeMnemonic(mnemonic: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('wallet_mnemonic', 'readwrite')
    const store = tx.objectStore('wallet_mnemonic')
    const getReq = store.get(MNEMONIC_KEY)

    getReq.onsuccess = () => {
      if (getReq.result !== undefined) {
        tx.abort()
        reject(
          new Error(
            'Mnemonic already exists. Refusing to overwrite — this would destroy access to existing funds.'
          )
        )
        return
      }
      store.put(mnemonic, MNEMONIC_KEY)
    }

    getReq.onerror = () => {
      reject(new Error(`IndexedDB get failed: ${getReq.error?.message ?? 'unknown'}`))
    }

    tx.oncomplete = () => resolve()
    tx.onerror = () => {
      if (!tx.error || tx.error.name === 'AbortError') return // Already rejected above
      reject(new Error(`IndexedDB put failed: ${tx.error.message}`))
    }
  })
}
