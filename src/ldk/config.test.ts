import { describe, it, expect } from 'vitest'
import { SIGNET_CONFIG } from './config'

describe('SIGNET_CONFIG', () => {
  it('has required configuration fields', () => {
    expect(SIGNET_CONFIG.esploraUrl).toBe('https://mutinynet.com/api')
    expect(SIGNET_CONFIG.genesisBlockHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('uses Signet network', () => {
    // Network.LDKNetwork_Signet = 4
    expect(SIGNET_CONFIG.network).toBe(4)
  })
})
