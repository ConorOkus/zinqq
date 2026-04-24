import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the `payjoin` module so we can test memoization without loading WASM.
// The real WASM load is exercised in E2E tests (Phase 3+).
const mockPayjoin = { SenderBuilder: class {} }
const uniffiInitAsync = vi.fn(() => Promise.resolve())

vi.mock('payjoin', () => ({
  payjoin: mockPayjoin,
  uniffiInitAsync,
}))

beforeEach(() => {
  vi.resetModules()
  uniffiInitAsync.mockClear()
})

describe('loadPdk', () => {
  it('resolves with the payjoin namespace after uniffiInitAsync', async () => {
    const { loadPdk } = await import('./pdk')
    const pdk = await loadPdk()
    expect(pdk).toBe(mockPayjoin)
    expect(uniffiInitAsync).toHaveBeenCalledTimes(1)
  })

  it('memoises — repeat calls share one init', async () => {
    const { loadPdk } = await import('./pdk')
    const [a, b] = await Promise.all([loadPdk(), loadPdk()])
    expect(a).toBe(b)
    expect(uniffiInitAsync).toHaveBeenCalledTimes(1)
  })
})
