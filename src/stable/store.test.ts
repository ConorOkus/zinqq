import { beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, clearAllStores, idbGet } from '../storage/idb'
import { StableStore, STABLE_VSS_KEY } from './store'

describe('stable position durable store', () => {
  const provider = { nodeId: '02' + '1'.repeat(64), host: 'stablechannels.com', port: 9735 }
  beforeEach(async () => {
    closeDb()
    await clearAllStores()
  })
  it('persists pending intents across a local restart', async () => {
    const store = new StableStore(provider, null)
    await store.load()
    await store.save({
      ...store.state,
      enabled: true,
      revision: 1,
      pending: {
        kind: 'trade',
        paymentId: '2'.repeat(64),
        preimage: '3'.repeat(64),
        amountMsat: '1000',
        tlv: '13377331',
        payload: '{}',
        createdAt: 1000,
        channelId: '4'.repeat(64),
        targetUsd: 100,
        backingSats: '100000',
        sent: false,
        correlation: {
          tradeId: '5'.repeat(64),
          paymentId: '2'.repeat(64),
          requestHash: '6'.repeat(64),
        },
      },
    })
    const restarted = new StableStore(provider, null)
    await restarted.load()
    expect(restarted.state.enabled).toBe(true)
    expect(restarted.state.revision).toBe(1)
    expect(restarted.state.pending?.paymentId).toBe('2'.repeat(64))
  })
  it('does not mutate financial state if the remote write fails', async () => {
    const remote = {
      getObject: vi.fn().mockResolvedValue(null),
      putObject: vi.fn().mockRejectedValue(new Error('backup failed')),
    }
    const store = new StableStore(provider, remote as never)
    await store.load()
    await expect(store.save({ ...store.state, enabled: true, revision: 1 })).rejects.toThrow(
      'backup failed'
    )
    expect(store.state.enabled).toBe(false)
    expect(await idbGet('ldk_stable_channels', 'primary')).toBeUndefined()
    expect(remote.putObject).toHaveBeenCalledWith(STABLE_VSS_KEY, expect.anything(), 0)
    expect(
      JSON.parse(new TextDecoder().decode(remote.putObject.mock.calls[0]![1] as Uint8Array))
    ).toMatchObject({ enabled: true, revision: 1 })
  })
  it('restores encrypted remote state and its CAS version before writing', async () => {
    const local = new StableStore(provider, null)
    const state = { ...local.state, enabled: true, revision: 5 }
    const remote = {
      getObject: vi
        .fn()
        .mockResolvedValue({ value: new TextEncoder().encode(JSON.stringify(state)), version: 7 }),
      putObject: vi.fn().mockResolvedValue(8),
    }
    const store = new StableStore(provider, remote as never)
    await store.load()
    expect(store.state.revision).toBe(5)
    await store.save({ ...store.state, paused: true, revision: 6 })
    expect(remote.putObject).toHaveBeenCalledWith(STABLE_VSS_KEY, expect.anything(), 7)
  })
  it('never overwrites a newer snapshot after a version conflict', async () => {
    const remote = {
      getObject: vi.fn().mockResolvedValue(null),
      putObject: vi.fn().mockRejectedValue(new Error('version conflict')),
    }
    const store = new StableStore(provider, remote as never)
    await store.load()
    await expect(store.save({ ...store.state, revision: 1 })).rejects.toThrow('version conflict')
    expect(remote.putObject).toHaveBeenCalledTimes(1)
    expect(remote.getObject).toHaveBeenCalledTimes(1)
  })
  it('rejects corrupt backup data instead of silently losing a position', async () => {
    const remote = {
      getObject: vi
        .fn()
        .mockResolvedValue({ value: new TextEncoder().encode('{"schema":0}'), version: 1 }),
    }
    await expect(new StableStore(provider, remote as never).load()).rejects.toThrow(
      'Invalid stable balance backup'
    )
  })
})
