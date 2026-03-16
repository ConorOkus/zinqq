import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock ChangeSet to avoid needing real BDK WASM descriptors in tests.
// The real ChangeSet.from_json / merge / to_json are tested implicitly
// through integration; here we verify the merge-before-persist logic.
const mockMerge = vi.fn()
vi.mock('@bitcoindevkit/bdk-wallet-web', () => ({
  ChangeSet: {
    from_json: vi.fn((json: string) => {
      const data = JSON.parse(json)
      return {
        _data: data,
        merge: mockMerge.mockImplementation(function (this: { _data: Record<string, unknown> }, other: { _data: Record<string, unknown> }) {
          Object.assign(this._data, other._data)
        }),
        to_json: function (this: { _data: Record<string, unknown> }) {
          return JSON.stringify(this._data)
        },
      }
    }),
  },
}))

let changesetModule: typeof import('./changeset')

beforeEach(async () => {
  const { closeDb } = await import('../../ldk/storage/idb')
  closeDb()
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('browser-wallet-ldk')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(new Error(req.error?.message ?? 'Failed to delete DB'))
  })
  vi.resetModules()
  mockMerge.mockClear()
  changesetModule = await import('./changeset')
})

describe('changeset storage', () => {
  it('returns undefined when no changeset stored', async () => {
    const result = await changesetModule.getChangeset()
    expect(result).toBeUndefined()
  })

  it('stores and retrieves a changeset', async () => {
    await changesetModule.putChangeset('{"network":"signet","local_chain":{}}')
    const result = await changesetModule.getChangeset()
    expect(result).toBeDefined()
    expect(result).toContain('signet')
  })

  it('merges successive changesets preserving earlier fields', async () => {
    await changesetModule.putChangeset('{"network":"signet"}')
    await changesetModule.putChangeset('{"tx_graph":{"txs":[]}}')

    const result = await changesetModule.getChangeset()
    expect(result).toBeDefined()
    // Network from first put should survive the merge
    expect(result).toContain('signet')
    // New data from second put should also be present
    expect(result).toContain('tx_graph')
    expect(mockMerge).toHaveBeenCalledTimes(1)
  })
})
