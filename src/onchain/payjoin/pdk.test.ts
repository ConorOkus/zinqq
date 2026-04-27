import { describe, it, expect } from 'vitest'
import { loadPdk } from './pdk'

describe('loadPdk', () => {
  it('rejects with a pdk_load-style error until the browser loader is wired', async () => {
    await expect(loadPdk()).rejects.toThrow(/PDK browser loader not yet wired/)
  })

  it('rejects on every call (no spurious memoised success)', async () => {
    await expect(loadPdk()).rejects.toBeInstanceOf(Error)
    await expect(loadPdk()).rejects.toBeInstanceOf(Error)
  })
})
