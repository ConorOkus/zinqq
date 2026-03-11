import { describe, it, expect, beforeEach, vi } from 'vitest'

// Re-import fresh module for each test to reset cached db connection
let idbModule: typeof import('./idb')

beforeEach(async () => {
  vi.resetModules()
  idbModule = await import('./idb')
})

describe('IndexedDB storage', () => {
  it('opens the database and creates object stores', async () => {
    const db = await idbModule.openDb()
    expect(db.objectStoreNames.contains('ldk_seed')).toBe(true)
    expect(db.objectStoreNames.contains('ldk_channel_monitors')).toBe(true)
    expect(db.objectStoreNames.contains('ldk_channel_manager')).toBe(true)
    expect(db.objectStoreNames.contains('ldk_network_graph')).toBe(true)
    expect(db.objectStoreNames.contains('ldk_scorer')).toBe(true)
  })

  it('puts and gets a value', async () => {
    const data = new Uint8Array([1, 2, 3, 4])
    await idbModule.idbPut('ldk_seed', 'test-key', data)
    const result = await idbModule.idbGet<Uint8Array>('ldk_seed', 'test-key')
    expect(Array.from(result!)).toEqual(Array.from(data))
  })

  it('returns undefined for missing key', async () => {
    const result = await idbModule.idbGet('ldk_seed', 'nonexistent')
    expect(result).toBeUndefined()
  })

  it('deletes a value', async () => {
    await idbModule.idbPut('ldk_seed', 'to-delete', 'value')
    await idbModule.idbDelete('ldk_seed', 'to-delete')
    const result = await idbModule.idbGet('ldk_seed', 'to-delete')
    expect(result).toBeUndefined()
  })

  it('gets all values from a store', async () => {
    await idbModule.idbPut('ldk_channel_monitors', 'a', new Uint8Array([1]))
    await idbModule.idbPut('ldk_channel_monitors', 'b', new Uint8Array([2]))
    const all = await idbModule.idbGetAll<Uint8Array>('ldk_channel_monitors')
    expect(all.size).toBe(2)
    expect(Array.from(all.get('a')!)).toEqual([1])
    expect(Array.from(all.get('b')!)).toEqual([2])
  })
})
