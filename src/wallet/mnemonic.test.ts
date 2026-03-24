import { describe, it, expect, beforeEach, vi } from 'vitest'

let mnemonicModule: typeof import('./mnemonic')

beforeEach(async () => {
  // Close any open DB, delete it, then re-import modules for a clean slate
  const { closeDb } = await import('../storage/idb')
  closeDb()
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('zinq-ldk')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(new Error(req.error?.message ?? 'Failed to delete DB'))
  })
  vi.resetModules()
  mnemonicModule = await import('./mnemonic')
})

describe('mnemonic', () => {
  it('generates a valid 12-word mnemonic', () => {
    const mnemonic = mnemonicModule.generateMnemonic()
    const words = mnemonic.split(' ')
    expect(words).toHaveLength(12)
    expect(mnemonicModule.validateMnemonic(mnemonic)).toBe(true)
  })

  it('validates a known valid mnemonic', () => {
    const valid =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    expect(mnemonicModule.validateMnemonic(valid)).toBe(true)
  })

  it('rejects an invalid mnemonic', () => {
    expect(mnemonicModule.validateMnemonic('not a valid mnemonic phrase at all')).toBe(false)
  })

  it('stores and retrieves a mnemonic from IDB', async () => {
    const mnemonic = mnemonicModule.generateMnemonic()
    await mnemonicModule.storeMnemonic(mnemonic)
    const retrieved = await mnemonicModule.getMnemonic()
    expect(retrieved).toBe(mnemonic)
  })

  it('refuses to overwrite an existing mnemonic', async () => {
    const mnemonic = mnemonicModule.generateMnemonic()
    await mnemonicModule.storeMnemonic(mnemonic)
    await expect(mnemonicModule.storeMnemonic('other words here')).rejects.toThrow(
      'Mnemonic already exists'
    )
  })

  it('returns undefined when no mnemonic stored', async () => {
    const result = await mnemonicModule.getMnemonic()
    expect(result).toBeUndefined()
  })
})
