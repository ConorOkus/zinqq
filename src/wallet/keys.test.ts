import { describe, it, expect } from 'vitest'
import { deriveLdkSeed, deriveBdkDescriptors } from './keys'

// Well-known test mnemonic (BIP39 test vector #0)
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('deriveLdkSeed', () => {
  it('returns a 32-byte Uint8Array', () => {
    const seed = deriveLdkSeed(TEST_MNEMONIC)
    expect(seed).toBeInstanceOf(Uint8Array)
    expect(seed).toHaveLength(32)
  })

  it('is deterministic (same mnemonic → same seed)', () => {
    const seed1 = deriveLdkSeed(TEST_MNEMONIC)
    const seed2 = deriveLdkSeed(TEST_MNEMONIC)
    expect(Array.from(seed1)).toEqual(Array.from(seed2))
  })

  it('produces different seeds for different mnemonics', () => {
    const seed1 = deriveLdkSeed(TEST_MNEMONIC)
    const otherMnemonic =
      'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'
    const seed2 = deriveLdkSeed(otherMnemonic)
    expect(Array.from(seed1)).not.toEqual(Array.from(seed2))
  })
})

describe('deriveBdkDescriptors', () => {
  it('returns external and internal descriptor strings', () => {
    const { external, internal } = deriveBdkDescriptors(TEST_MNEMONIC, 'signet')
    expect(external).toMatch(/^wpkh\(\[/)
    expect(internal).toMatch(/^wpkh\(\[/)
    expect(external).toContain("/0/*)")
    expect(internal).toContain("/1/*)")
  })

  it('uses coin type 1 for signet', () => {
    const { external } = deriveBdkDescriptors(TEST_MNEMONIC, 'signet')
    // Origin should contain 84'/1'/0'
    expect(external).toMatch(/84'\/1'\/0'/)
  })

  it('uses coin type 0 for bitcoin mainnet', () => {
    const { external } = deriveBdkDescriptors(TEST_MNEMONIC, 'bitcoin')
    expect(external).toMatch(/84'\/0'\/0'/)
  })

  it('is deterministic', () => {
    const d1 = deriveBdkDescriptors(TEST_MNEMONIC, 'signet')
    const d2 = deriveBdkDescriptors(TEST_MNEMONIC, 'signet')
    expect(d1.external).toBe(d2.external)
    expect(d1.internal).toBe(d2.internal)
  })

  it('contains the master fingerprint in the origin', () => {
    const { external } = deriveBdkDescriptors(TEST_MNEMONIC, 'signet')
    // The "abandon" mnemonic master fingerprint is 73c5da0a
    expect(external).toMatch(/\[73c5da0a\//)
  })

  it('uses tprv for signet and xprv for mainnet', () => {
    const signet = deriveBdkDescriptors(TEST_MNEMONIC, 'signet')
    const signetMatch = signet.external.match(/\](tprv[A-Za-z0-9]+)\/0\/\*\)/)
    expect(signetMatch).not.toBeNull()
    expect(signetMatch![1]).toMatch(/^tprv/)

    const mainnet = deriveBdkDescriptors(TEST_MNEMONIC, 'bitcoin')
    const mainnetMatch = mainnet.external.match(/\](xprv[A-Za-z0-9]+)\/0\/\*\)/)
    expect(mainnetMatch).not.toBeNull()
    expect(mainnetMatch![1]).toMatch(/^xprv/)
  })
})
