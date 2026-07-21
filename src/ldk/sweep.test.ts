import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock IDB storage
vi.mock('../storage/idb', () => ({
  idbGetAll: vi.fn(),
  idbDeleteBatch: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../storage/error-log', () => ({
  captureError: vi.fn(),
}))

vi.mock('../shared/fee-cache', () => ({
  getFeeRate: vi.fn().mockResolvedValue(10),
}))

vi.mock('./traits/broadcaster', () => ({
  broadcastWithRetry: vi.fn(),
}))

// Mock lightningdevkit — descriptors decode to `{ marker }` objects so tests
// can steer the OutputSpender mock per descriptor. A serialized descriptor is
// a 1-byte Uint8Array whose value is the marker.
vi.mock('lightningdevkit', () => {
  class Result_SpendableOutputDescriptorDecodeErrorZ_OK {
    res: unknown
    constructor(res: unknown) {
      this.res = res
    }
  }
  class Result_TransactionNoneZ_OK {
    res: Uint8Array
    constructor(res: Uint8Array) {
      this.res = res
    }
  }
  return {
    Result_SpendableOutputDescriptorDecodeErrorZ_OK,
    Result_TransactionNoneZ_OK,
    SpendableOutputDescriptor: {
      constructor_read: (bytes: Uint8Array) =>
        bytes[0] === 0xff
          ? { decodeError: true } // not an OK instance → deserialization failure
          : new Result_SpendableOutputDescriptorDecodeErrorZ_OK({ marker: bytes[0] }),
    },
    Option_u32Z: {
      constructor_none: () => 'none',
    },
  }
})

import {
  sweepSpendableOutputs,
  getPendingSweepInfo,
  SWEEP_STATE_EVENT,
  type SpendableOutputsEntry,
} from './sweep'
import { idbGetAll, idbDeleteBatch } from '../storage/idb'
import { broadcastWithRetry } from './traits/broadcaster'
import { Result_TransactionNoneZ_OK } from 'lightningdevkit'
import type { KeysManager } from 'lightningdevkit'

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */

const DUST_MARKER = 0x01
const GOOD_MARKER = 0x02

function entry(
  markers: number[],
  channelIdHex: string | null = null,
  valueSats: string[] = []
): SpendableOutputsEntry {
  return {
    descriptors: markers.map((m) => new Uint8Array([m])),
    channelIdHex,
    outpoints: valueSats.map((v, i) => ({ txid: 'closetx', vout: i, valueSats: v })),
  }
}

/**
 * KeysManager whose OutputSpender fails any spend that includes a dust-marked
 * descriptor (mirrors LDK failing the whole transaction) and returns a tx
 * whose bytes encode the spent markers otherwise.
 */
function makeKeysManager(): { keysManager: KeysManager; spendCalls: number[][] } {
  const spendCalls: number[][] = []
  const spend_spendable_outputs = (descriptors: { marker: number }[]) => {
    const markers = descriptors.map((d) => d.marker)
    spendCalls.push(markers)
    if (markers.includes(DUST_MARKER)) return { err: 'dust' }
    // The mocked class has a public constructor; the real one is protected.
    return new (Result_TransactionNoneZ_OK as any)(new Uint8Array(markers))
  }
  const keysManager = {
    as_OutputSpender: () => ({ spend_spendable_outputs }),
  } as unknown as KeysManager
  return { keysManager, spendCalls }
}

async function runSweep(keysManager: KeysManager) {
  return sweepSpendableOutputs(keysManager, new Uint8Array([0xaa]), 'https://esplora.test')
}

describe('sweepSpendableOutputs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(broadcastWithRetry).mockImplementation((_url, txHex) =>
      Promise.resolve(`txid-${txHex}`)
    )
  })

  it('sweeps all entries in a single bundled transaction', async () => {
    vi.mocked(idbGetAll).mockResolvedValue(
      new Map<string, SpendableOutputsEntry>([
        ['k1', entry([GOOD_MARKER], 'chan-a')],
        ['k2', entry([GOOD_MARKER], 'chan-b')],
      ])
    )
    const { keysManager, spendCalls } = makeKeysManager()

    const result = await runSweep(keysManager)

    expect(spendCalls).toEqual([[GOOD_MARKER, GOOD_MARKER]])
    expect(broadcastWithRetry).toHaveBeenCalledTimes(1)
    expect(result.swept).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.txs).toHaveLength(1)
    expect(result.txs[0]!.attributions.map((a) => a.channelIdHex)).toEqual(['chan-a', 'chan-b'])
    expect(idbDeleteBatch).toHaveBeenCalledWith('ldk_spendable_outputs', ['k1', 'k2'])
  })

  it('leaves all entries pending and flags the failure when the bundle cannot build', async () => {
    const entries = new Map<string, SpendableOutputsEntry>([
      ['dust', entry([DUST_MARKER], 'chan-dust', ['300'])],
      ['good', entry([GOOD_MARKER], 'chan-good', ['2500'])],
    ])
    vi.mocked(idbGetAll).mockResolvedValue(entries)
    const { keysManager } = makeKeysManager()

    const stateEvents = vi.fn()
    window.addEventListener(SWEEP_STATE_EVENT, stateEvents)
    const result = await runSweep(keysManager)
    window.removeEventListener(SWEEP_STATE_EVENT, stateEvents)

    expect(result.swept).toBe(0)
    expect(result.skipped).toBe(2)
    expect(result.txs).toEqual([])
    expect(broadcastWithRetry).not.toHaveBeenCalled()
    expect(idbDeleteBatch).not.toHaveBeenCalled()
    expect(stateEvents).toHaveBeenCalledTimes(1)

    const pending = await getPendingSweepInfo()
    expect(pending).toEqual({
      entryCount: 2,
      descriptorCount: 2,
      pendingSats: 2800n,
      hasUnknownValue: false,
      lastAttemptFailed: true,
    })
  })

  it('clears the failure flag once a later sweep succeeds', async () => {
    const { keysManager } = makeKeysManager()

    // First attempt fails (dust in bundle)
    vi.mocked(idbGetAll).mockResolvedValue(
      new Map<string, SpendableOutputsEntry>([['dust', entry([DUST_MARKER])]])
    )
    await runSweep(keysManager)
    vi.mocked(idbGetAll).mockResolvedValue(
      new Map<string, SpendableOutputsEntry>([['dust', entry([DUST_MARKER], null, ['300'])]])
    )
    expect((await getPendingSweepInfo())?.lastAttemptFailed).toBe(true)

    // Fees dropped / outputs matured — same entries now sweep
    vi.mocked(idbGetAll).mockResolvedValue(
      new Map<string, SpendableOutputsEntry>([['dust', entry([GOOD_MARKER])]])
    )
    const result = await runSweep(keysManager)
    expect(result.swept).toBe(1)

    vi.mocked(idbGetAll).mockResolvedValue(new Map())
    expect(await getPendingSweepInfo()).toBeNull()
  })

  it('keeps entries and flags the failure when broadcast fails', async () => {
    vi.mocked(idbGetAll).mockResolvedValue(
      new Map<string, SpendableOutputsEntry>([['good', entry([GOOD_MARKER], 'chan-a')]])
    )
    const { keysManager } = makeKeysManager()
    vi.mocked(broadcastWithRetry).mockRejectedValue(new Error('mempool rejected'))

    const result = await runSweep(keysManager)

    expect(result.swept).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.txs).toEqual([])
    expect(idbDeleteBatch).not.toHaveBeenCalled()
    vi.mocked(idbGetAll).mockResolvedValue(
      new Map<string, SpendableOutputsEntry>([['good', entry([GOOD_MARKER], 'chan-a')]])
    )
    expect((await getPendingSweepInfo())?.lastAttemptFailed).toBe(true)
  })

  it('sweeps legacy bare-array entries with null attribution', async () => {
    vi.mocked(idbGetAll).mockResolvedValue(
      new Map<string, Uint8Array[]>([['legacy', [new Uint8Array([GOOD_MARKER])]]]) as any
    )
    const { keysManager } = makeKeysManager()

    const result = await runSweep(keysManager)

    expect(result.swept).toBe(1)
    expect(result.txs[0]!.attributions).toEqual([{ channelIdHex: null, outpoints: [] }])
  })

  it('skips undecodable entries without attempting to spend them', async () => {
    vi.mocked(idbGetAll).mockResolvedValue(
      new Map<string, SpendableOutputsEntry>([
        ['bad', entry([0xff])],
        ['good', entry([GOOD_MARKER])],
      ])
    )
    const { keysManager, spendCalls } = makeKeysManager()

    const result = await runSweep(keysManager)

    expect(spendCalls).toEqual([[GOOD_MARKER]])
    expect(result.swept).toBe(1)
    expect(result.skipped).toBe(1)
    expect(idbDeleteBatch).toHaveBeenCalledWith('ldk_spendable_outputs', ['good'])
    // The undecodable entry is still stuck in IDB — the pending state must
    // stay flagged so the banner doesn't hide it after the partial success.
    vi.mocked(idbGetAll).mockResolvedValue(
      new Map<string, SpendableOutputsEntry>([['bad', entry([0xff])]])
    )
    expect((await getPendingSweepInfo())?.lastAttemptFailed).toBe(true)
  })

  it('flags failed pending state when every entry is undecodable', async () => {
    vi.mocked(idbGetAll).mockResolvedValue(
      new Map<string, SpendableOutputsEntry>([
        ['bad-1', entry([0xff])],
        ['bad-2', entry([0xff])],
      ])
    )
    const { keysManager, spendCalls } = makeKeysManager()

    const stateEvents = vi.fn()
    window.addEventListener(SWEEP_STATE_EVENT, stateEvents)
    const result = await runSweep(keysManager)
    window.removeEventListener(SWEEP_STATE_EVENT, stateEvents)

    expect(spendCalls).toEqual([])
    expect(result.swept).toBe(0)
    expect(result.skipped).toBe(2)
    expect(broadcastWithRetry).not.toHaveBeenCalled()
    expect(idbDeleteBatch).not.toHaveBeenCalled()
    expect(stateEvents).toHaveBeenCalledTimes(1)
    expect((await getPendingSweepInfo())?.lastAttemptFailed).toBe(true)
  })
})

describe('getPendingSweepInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when nothing is pending', async () => {
    vi.mocked(idbGetAll).mockResolvedValue(new Map())
    expect(await getPendingSweepInfo()).toBeNull()
  })

  it('sums known outpoint values and flags entries with unknown value', async () => {
    vi.mocked(idbGetAll).mockResolvedValue(
      new Map<string, Uint8Array[] | SpendableOutputsEntry>([
        ['a', entry([GOOD_MARKER], 'chan-a', ['1500', '500'])],
        ['legacy', [new Uint8Array([GOOD_MARKER])]],
      ])
    )

    const pending = await getPendingSweepInfo()

    expect(pending?.entryCount).toBe(2)
    expect(pending?.descriptorCount).toBe(2)
    expect(pending?.pendingSats).toBe(2000n)
    expect(pending?.hasUnknownValue).toBe(true)
  })

  it('treats malformed valueSats as unknown value instead of throwing', async () => {
    vi.mocked(idbGetAll).mockResolvedValue(
      new Map<string, SpendableOutputsEntry>([
        ['a', entry([GOOD_MARKER], 'chan-a', ['not-a-number', '1500'])],
      ])
    )

    const pending = await getPendingSweepInfo()

    expect(pending?.pendingSats).toBe(1500n)
    expect(pending?.hasUnknownValue).toBe(true)
  })
})
