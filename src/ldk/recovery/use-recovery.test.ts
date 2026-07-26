import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory IDB stand-in — recovery-state (and error-log) resolve to the
// same mocked module, so reads observe writes within a test.
const idbStore = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../../storage/idb', () => ({
  idbGet: vi.fn((store: string, key: string) => Promise.resolve(idbStore.get(`${store}/${key}`))),
  idbPut: vi.fn((store: string, key: string, value: unknown) => {
    idbStore.set(`${store}/${key}`, value)
    return Promise.resolve()
  }),
  idbDelete: vi.fn((store: string, key: string) => {
    idbStore.delete(`${store}/${key}`)
    return Promise.resolve()
  }),
  idbGetAll: vi.fn(() => Promise.resolve([])),
  idbDeleteBatch: vi.fn(() => Promise.resolve()),
}))

// Pin the fee estimate so depositNeededSat is deterministic (140 vB × 1 sat/vB
// × 1.5 buffer → rounds up to 5,000).
vi.mock('../../shared/fee-cache', () => ({
  getFeeRate: vi.fn(() => Promise.resolve(1)),
}))

import { enterRecovery } from './use-recovery'
import { readRecoveryState } from './recovery-state'

beforeEach(() => {
  idbStore.clear()
})

describe('enterRecovery stuck-balance aggregation', () => {
  it('records a known balance', async () => {
    await enterRecovery(
      { channelId: 'aa', localBalanceSat: 40_000, reason: 'no utxos' },
      'bc1qdeposit',
      null
    )
    const state = await readRecoveryState()
    expect(state?.stuckBalanceSat).toBe(40_000)
    expect(state?.status).toBe('needs_recovery')
    expect(state?.depositNeededSat).toBe(5_000)
  })

  it('records null (unknown) instead of a false zero when the close record is missing', async () => {
    await enterRecovery(
      { channelId: 'aa', localBalanceSat: null, reason: 'no utxos' },
      'bc1qdeposit',
      null
    )
    const state = await readRecoveryState()
    expect(state?.stuckBalanceSat).toBeNull()
  })

  it('sums known balances across aggregated channels', async () => {
    await enterRecovery(
      { channelId: 'aa', localBalanceSat: 40_000, reason: 'no utxos' },
      'bc1qdeposit',
      null
    )
    await enterRecovery(
      { channelId: 'bb', localBalanceSat: 2_500, reason: 'no utxos' },
      'bc1qdeposit',
      null
    )
    const state = await readRecoveryState()
    expect(state?.stuckBalanceSat).toBe(42_500)
    expect(state?.channelIds).toEqual(['aa', 'bb'])
  })

  it('an unknown balance on either side poisons the sum to null', async () => {
    await enterRecovery(
      { channelId: 'aa', localBalanceSat: 40_000, reason: 'no utxos' },
      'bc1qdeposit',
      null
    )
    await enterRecovery(
      { channelId: 'bb', localBalanceSat: null, reason: 'no utxos' },
      'bc1qdeposit',
      null
    )
    const state = await readRecoveryState()
    expect(state?.stuckBalanceSat).toBeNull()
  })

  it('re-signaling an already-tracked channel is a no-op', async () => {
    await enterRecovery(
      { channelId: 'aa', localBalanceSat: null, reason: 'no utxos' },
      'bc1qdeposit',
      null
    )
    await enterRecovery(
      { channelId: 'aa', localBalanceSat: 40_000, reason: 'no utxos' },
      'bc1qdeposit',
      null
    )
    const state = await readRecoveryState()
    expect(state?.stuckBalanceSat).toBeNull()
    expect(state?.channelIds).toEqual(['aa'])
  })
})
