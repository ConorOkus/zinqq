import { describe, it, expect, vi, beforeEach } from 'vitest'
import { syncOnce } from './chain-sync'
import type { EsploraClient } from './esplora-client'
import type { WatchState } from '../traits/filter'

// Mock lightningdevkit
vi.mock('lightningdevkit', () => ({
  TwoTuple_usizeTransactionZ: {
    constructor_new: vi.fn((pos: number, tx: Uint8Array) => ({ pos, tx })),
  },
}))

// Mock idbPut
vi.mock('../../storage/idb', () => ({
  idbPut: vi.fn().mockResolvedValue(undefined),
}))

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/unbound-method, @typescript-eslint/require-await, @typescript-eslint/no-misused-promises */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockConfirmable(): any {
  return {
    get_relevant_txids: vi.fn().mockReturnValue([]),
    transaction_unconfirmed: vi.fn(),
    best_block_updated: vi.fn(),
    transactions_confirmed: vi.fn(),
  }
}

function createMockEsplora(tipHash = 'newtip'): EsploraClient {
  return {
    setSignal: vi.fn(),
    getTipHash: vi.fn().mockResolvedValue(tipHash),
    getBlockHeight: vi.fn().mockResolvedValue(100),
    getBlockHeader: vi.fn().mockResolvedValue(new Uint8Array(80)),
    getBlockStatus: vi.fn().mockResolvedValue({ in_best_chain: true, height: 100 }),
    getTxStatus: vi.fn().mockResolvedValue({ confirmed: false }),
    getTxHex: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    getTxMerkleProof: vi.fn().mockResolvedValue({ block_height: 100, merkle: [], pos: 0 }),
    getOutspend: vi.fn().mockResolvedValue({ spent: false }),
  } as unknown as EsploraClient
}

function createEmptyWatchState(): WatchState {
  return {
    watchedTxids: new Map(),
    watchedOutputs: new Map(),
  }
}

describe('syncOnce', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('skips sync when tip hash unchanged', async () => {
    const confirmable = createMockConfirmable()
    const esplora = createMockEsplora('sametip')
    const watchState = createEmptyWatchState()

    const result = await syncOnce([confirmable], watchState, esplora, 'sametip')

    expect(result).toBe('sametip')
    expect(confirmable.best_block_updated).not.toHaveBeenCalled()
  })

  it('calls best_block_updated when tip changes', async () => {
    const confirmable = createMockConfirmable()
    const esplora = createMockEsplora('newtip')
    const watchState = createEmptyWatchState()

    await syncOnce([confirmable], watchState, esplora, 'oldtip')

    expect(confirmable.best_block_updated).toHaveBeenCalledWith(expect.any(Uint8Array), 100)
  })

  it('calls transaction_unconfirmed for reorged transactions', async () => {
    const confirmable = createMockConfirmable()
    const txid = new Uint8Array([0x01])
    const blockHash = new Uint8Array([0xaa, 0xbb])

    confirmable.get_relevant_txids.mockReturnValue([
      {
        get_a: () => txid,
        get_b: () => 50,
        get_c: () => blockHash,
      },
    ])

    const esplora = createMockEsplora('newtip')
    ;(esplora.getBlockStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      in_best_chain: false,
      height: 50,
    })

    const watchState = createEmptyWatchState()

    await syncOnce([confirmable], watchState, esplora, 'oldtip')

    expect(confirmable.transaction_unconfirmed).toHaveBeenCalledWith(txid)
  })

  it('skips reorg check when block hash is empty Uint8Array', async () => {
    const confirmable = createMockConfirmable()
    confirmable.get_relevant_txids.mockReturnValue([
      {
        get_a: () => new Uint8Array([0x01]),
        get_b: () => 50,
        get_c: () => new Uint8Array(0), // LDK WASM returns empty array for None
      },
    ])

    const esplora = createMockEsplora('newtip')
    const watchState = createEmptyWatchState()

    await syncOnce([confirmable], watchState, esplora, 'oldtip')

    expect(esplora.getBlockStatus).not.toHaveBeenCalled()
    expect(confirmable.transaction_unconfirmed).not.toHaveBeenCalled()
  })

  it('confirms watched transactions that are confirmed on chain', async () => {
    const confirmable = createMockConfirmable()
    const esplora = createMockEsplora('newtip')
    ;(esplora.getTxStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      confirmed: true,
      block_height: 99,
      block_hash: 'blockhash99',
    })

    const watchState = createEmptyWatchState()
    watchState.watchedTxids.set('deadbeef', new Uint8Array([0xaa]))

    await syncOnce([confirmable], watchState, esplora, 'oldtip')

    expect(confirmable.transactions_confirmed).toHaveBeenCalled()
  })

  it('checks watched outputs for spends', async () => {
    const confirmable = createMockConfirmable()
    const esplora = createMockEsplora('newtip')
    ;(esplora.getOutspend as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      spent: true,
      txid: 'spending_txid',
    })
    ;(esplora.getTxStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      confirmed: true,
      block_height: 98,
      block_hash: 'blockhash98',
    })

    const watchState = createEmptyWatchState()
    watchState.watchedOutputs.set('abcd:0', {} as never)

    await syncOnce([confirmable], watchState, esplora, 'oldtip')

    expect(confirmable.transactions_confirmed).toHaveBeenCalled()
  })

  it('returns the new tip hash', async () => {
    const confirmable = createMockConfirmable()
    const esplora = createMockEsplora('brandnewtip')
    const watchState = createEmptyWatchState()

    const result = await syncOnce([confirmable], watchState, esplora, 'oldtip')

    expect(result).toBe('brandnewtip')
  })

  it('sets and clears the external signal on esplora', async () => {
    const confirmable = createMockConfirmable()
    const esplora = createMockEsplora('newtip')
    const watchState = createEmptyWatchState()
    const signal = AbortSignal.timeout(5000)

    await syncOnce([confirmable], watchState, esplora, 'oldtip', signal)

    expect(esplora.setSignal).toHaveBeenCalledWith(signal)
  })

  it('aborts when signal is already aborted', async () => {
    const confirmable = createMockConfirmable()
    const esplora = createMockEsplora('newtip')
    // Make getTipHash respect the abort signal
    ;(esplora.getTipHash as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError')
    })
    const watchState = createEmptyWatchState()
    const controller = new AbortController()
    controller.abort()

    await expect(
      syncOnce([confirmable], watchState, esplora, 'oldtip', controller.signal)
    ).rejects.toThrow('aborted')
  })
})
