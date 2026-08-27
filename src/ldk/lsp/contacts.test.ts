import { describe, it, expect, vi } from 'vitest'

vi.mock('../config', () => ({
  LDK_CONFIG: {
    lspNodeId: '02'.padEnd(66, '0'),
    lspHost: 'lsp.config.example',
    lspPort: 9735,
    lspToken: 'tok',
    lspLabel: 'candidate-lsp',
  },
}))

const { resolveLspContacts } = await import('./contacts')

describe('resolveLspContacts', () => {
  it('takes the telemetry label from config rather than hardcoding megalith', async () => {
    // Regression: the label was hardcoded to 'megalith', so pointing the env
    // vars at a candidate LSP still tagged its logs and telemetry as Megalith,
    // silently misattributing one provider's behavior to another.
    const { primary } = await resolveLspContacts()

    expect(primary?.label).toBe('candidate-lsp')
    expect(primary?.nodeId).toBe('02'.padEnd(66, '0'))
    expect(primary?.token).toBe('tok')
  })

  it('leaves the fallback slot empty', async () => {
    expect((await resolveLspContacts()).fallback).toBeNull()
  })
})
