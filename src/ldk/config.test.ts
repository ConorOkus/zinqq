import { describe, it, expect, vi, afterEach } from 'vitest'
import { LDK_CONFIG } from './config'

/**
 * Re-imports config.ts with `VITE_LSP_LABEL` stubbed, so the env-parsing itself is
 * exercised. The `contacts.test.ts` suite mocks this module wholesale, so without
 * these cases the only new production line in the label change runs in no test.
 */
async function loadConfigWithLabel(value: string | undefined) {
  // `undefined` genuinely removes the variable, so the unset case is the real one.
  vi.stubEnv('VITE_LSP_LABEL', value)
  vi.resetModules()
  return (await import('./config')).LDK_CONFIG
}

describe('LDK_CONFIG', () => {
  it('has required configuration fields', () => {
    expect(LDK_CONFIG.esploraUrl).toBeTruthy()
    expect(LDK_CONFIG.wsProxyUrl).toBeTruthy()
  })

  it('defaults to mainnet network', () => {
    // Network.LDKNetwork_Bitcoin = 0
    expect(LDK_CONFIG.network).toBe(0)
  })

  it('has the mainnet genesis block hash', () => {
    expect(LDK_CONFIG.genesisBlockHash).toBe(
      '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
    )
  })
})

describe('LDK_CONFIG.lspLabel', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('reads the label from VITE_LSP_LABEL', async () => {
    expect((await loadConfigWithLabel('candidate-lsp')).lspLabel).toBe('candidate-lsp')
  })

  it('trims surrounding whitespace', async () => {
    expect((await loadConfigWithLabel('  candidate-lsp  ')).lspLabel).toBe('candidate-lsp')
  })

  it('falls back to megalith when unset', async () => {
    expect((await loadConfigWithLabel(undefined)).lspLabel).toBe('megalith')
  })

  it('falls back to megalith when whitespace-only', async () => {
    // Pins the `?.trim() || DEFAULT` ordering. Every sibling field uses
    // `(env ?? DEFAULT).trim()`, which would leave '' here instead — an
    // empty telemetry label that attributes logs to nothing at all.
    expect((await loadConfigWithLabel('   ')).lspLabel).toBe('megalith')
  })
})
