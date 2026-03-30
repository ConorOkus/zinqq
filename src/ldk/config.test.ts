import { describe, it, expect } from 'vitest'
import { LDK_CONFIG, ACTIVE_NETWORK } from './config'

describe('LDK_CONFIG', () => {
  it('has required configuration fields', () => {
    expect(LDK_CONFIG.esploraUrl).toMatch(/^https:\/\//)
    expect(LDK_CONFIG.wsProxyUrl).toBeTruthy()
  })

  it('defaults to signet network', () => {
    // VITE_NETWORK is unset in tests, so defaults to signet
    expect(ACTIVE_NETWORK).toBe('signet')
    // Network.LDKNetwork_Signet = 4
    expect(LDK_CONFIG.network).toBe(4)
  })

  it('has a genesis block hash', () => {
    expect(LDK_CONFIG.genesisBlockHash).toMatch(/^[0-9a-f]{64}$/)
  })
})
