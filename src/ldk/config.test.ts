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
  const ACK = 'single-recipient-deployment'

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

  it('accepts well-formed paths with a valid node id and the recipient ack', async () => {
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_PATHS', '0001aabbcc')
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_NODE_ID', NODE_ID)
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_RECIPIENT_ACK', ACK)
    const { LDK_CONFIG: config } = await loadConfig()
    expect(config.staticInvoiceServerPaths).toBe('0001aabbcc')
    expect(config.staticInvoiceServerNodeId).toBe(NODE_ID)
  })

  it('throws when paths are set but the node id is empty', async () => {
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_PATHS', 'abcd')
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_NODE_ID', '')
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_RECIPIENT_ACK', ACK)
    await expect(loadConfig()).rejects.toThrow(/staticInvoiceServerNodeId/)
  })

  it('throws when the node id is not 66-character lowercase hex', async () => {
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_PATHS', 'abcd')
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_NODE_ID', 'AA'.repeat(33))
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_RECIPIENT_ACK', ACK)
    await expect(loadConfig()).rejects.toThrow(/staticInvoiceServerNodeId/)
  })

  it('throws when paths are set without the single-recipient acknowledgement', async () => {
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_PATHS', '0001aabbcc')
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_NODE_ID', NODE_ID)
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_RECIPIENT_ACK', '')
    await expect(loadConfig()).rejects.toThrow(/RECIPIENT_ACK/)
  })

  it('throws when the acknowledgement is set to the wrong value', async () => {
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_PATHS', '0001aabbcc')
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_NODE_ID', NODE_ID)
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_RECIPIENT_ACK', 'yes')
    await expect(loadConfig()).rejects.toThrow(/RECIPIENT_ACK/)
  })

  it('does not require the acknowledgement when the feature is off', async () => {
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_PATHS', '')
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_RECIPIENT_ACK', '')
    const { LDK_CONFIG: config } = await loadConfig()
    expect(config.staticInvoiceServerPaths).toBe('')
  })

  it('throws on a non-hex blob', async () => {
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_PATHS', 'abcdzzzz')
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_NODE_ID', NODE_ID)
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_RECIPIENT_ACK', ACK)
    await expect(loadConfig()).rejects.toThrow(/not even-length lowercase hex/)
  })

  it('throws on an odd-length blob', async () => {
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_PATHS', 'abc')
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_NODE_ID', NODE_ID)
    vi.stubEnv('VITE_STATIC_INVOICE_SERVER_RECIPIENT_ACK', ACK)
    await expect(loadConfig()).rejects.toThrow(/not even-length lowercase hex/)
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
