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

  it('leaves the async-receive feature off by default', () => {
    expect(LDK_CONFIG.staticInvoiceServerPaths).toBe('')
    expect(LDK_CONFIG.staticInvoiceServerNodeId).toBe('')
  })
})

// The validation lives at module scope, so each case re-imports the module
// under stubbed env vars.
describe('LDK_CONFIG static invoice server validation', () => {
  const NODE_ID = 'aa'.repeat(33)

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  async function loadConfig() {
    vi.resetModules()
    return import('./config')
  }

  it('accepts an empty paths setting even when the node id is also empty', async () => {
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_PATHS', '')
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_NODE_ID', '')
    const { LDK_CONFIG: config } = await loadConfig()
    expect(config.staticInvoiceServerPaths).toBe('')
  })

  it('accepts well-formed paths with a valid node id', async () => {
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_PATHS', 'abcd,ef01')
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_NODE_ID', NODE_ID)
    const { LDK_CONFIG: config } = await loadConfig()
    expect(config.staticInvoiceServerPaths).toBe('abcd,ef01')
    expect(config.staticInvoiceServerNodeId).toBe(NODE_ID)
  })

  it('throws when paths are set but the node id is empty', async () => {
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_PATHS', 'abcd')
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_NODE_ID', '')
    await expect(loadConfig()).rejects.toThrow(/staticInvoiceServerNodeId/)
  })

  it('throws when the node id is not 66-character lowercase hex', async () => {
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_PATHS', 'abcd')
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_NODE_ID', 'AA'.repeat(33))
    await expect(loadConfig()).rejects.toThrow(/staticInvoiceServerNodeId/)
  })

  it('throws on a non-hex path entry', async () => {
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_PATHS', 'abcd,zzzz')
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_NODE_ID', NODE_ID)
    await expect(loadConfig()).rejects.toThrow(/entry 1 is not even-length lowercase hex/)
  })

  it('throws on an odd-length path entry', async () => {
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_PATHS', 'abc')
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_NODE_ID', NODE_ID)
    await expect(loadConfig()).rejects.toThrow(/entry 0 is not even-length lowercase hex/)
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
