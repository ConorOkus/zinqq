import { describe, it, expect, vi } from 'vitest'

// Mock lightningdevkit since we can't load WASM in tests
vi.mock('lightningdevkit', () => {
  return {
    Filter: {
      new_impl: vi.fn((impl: Record<string, unknown>) => impl),
    },
  }
})

describe('createFilter', () => {
  it('accumulates watched txids', async () => {
    // Dynamic import after mocking
    const { createFilter } = await import('./filter')
    const { watchState, filter } = createFilter()

    const txid = new Uint8Array([0x01, 0x02, 0x03])
    const scriptPubkey = new Uint8Array([0xaa, 0xbb])

    // Call register_tx through the filter impl
    const impl = filter as unknown as { register_tx: (txid: Uint8Array, sp: Uint8Array) => void }
    impl.register_tx(txid, scriptPubkey)

    expect(watchState.watchedTxids.size).toBe(1)
    // txid bytes are reversed to display order: [01,02,03] -> '030201'
    expect(watchState.watchedTxids.has('030201')).toBe(true)
    expect(Array.from(watchState.watchedTxids.get('030201')!)).toEqual([0xaa, 0xbb])
  })

  it('accumulates watched outputs', async () => {
    const { createFilter } = await import('./filter')
    const { watchState, filter } = createFilter()

    const mockOutput = {
      get_outpoint: () => ({
        get_txid: () => new Uint8Array([0x0a, 0x0b]),
        get_index: () => 2,
      }),
    }

    const impl = filter as unknown as { register_output: (o: unknown) => void }
    impl.register_output(mockOutput)

    expect(watchState.watchedOutputs.size).toBe(1)
    // txid bytes are reversed to display order: [0a,0b] -> '0b0a'
    expect(watchState.watchedOutputs.has('0b0a:2')).toBe(true)
  })
})
