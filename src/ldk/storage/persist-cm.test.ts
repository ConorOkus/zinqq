import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createChannelManagerPersistScheduler,
  persistChannelManager,
  persistChannelManagerIdbOnly,
  VssConflictDuringTakeoverError,
} from './persist-cm'
import { VssError, type VssClient } from './vss-client'
import { ErrorCode } from './proto/vss_pb'

vi.mock('../../storage/idb', () => ({
  idbPut: vi.fn().mockResolvedValue(undefined),
}))

import { idbPut } from '../../storage/idb'

/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await */

function makeCm(data = new Uint8Array([1, 2, 3])) {
  return {
    write: vi.fn(() => data),
    get_and_clear_needs_persistence: vi.fn(() => false),
  } as never
}

interface DirtyCm {
  write: ReturnType<typeof vi.fn>
  get_and_clear_needs_persistence: ReturnType<typeof vi.fn>
  setDirty: () => void
}

// Mock CM that simulates LDK's dirty-bit semantics: get_and_clear returns
// true exactly once per setDirty() call, then false until set again.
function makeDirtyCm(data = new Uint8Array([1, 2, 3])): DirtyCm {
  let dirty = false
  return {
    write: vi.fn(() => data),
    get_and_clear_needs_persistence: vi.fn(() => {
      const wasDirty = dirty
      dirty = false
      return wasDirty
    }),
    setDirty: () => {
      dirty = true
    },
  }
}

function makeVssClient(overrides: Partial<VssClient> = {}): VssClient {
  return {
    putObject: vi.fn().mockResolvedValue(1),
    getObject: vi.fn().mockResolvedValue(null),
    putObjects: vi.fn().mockResolvedValue(undefined),
    deleteObject: vi.fn().mockResolvedValue(undefined),
    listKeyVersions: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as VssClient
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('persistChannelManager', () => {
  beforeEach(() => {
    vi.mocked(idbPut).mockReset().mockResolvedValue(undefined)
  })

  it('writes to IDB when no VSS client provided', async () => {
    const cm = makeCm(new Uint8Array([10, 20]))
    await persistChannelManager(cm)

    expect(idbPut).toHaveBeenCalledWith('ldk_channel_manager', 'primary', new Uint8Array([10, 20]))
  })

  it('writes to VSS first, then IDB', async () => {
    const callOrder: string[] = []
    const vssClient = makeVssClient({
      putObject: vi.fn().mockImplementation(async () => {
        callOrder.push('vss')
        return 1
      }),
    })
    vi.mocked(idbPut).mockImplementation(async () => {
      callOrder.push('idb')
    })

    const cm = makeCm()
    const cmVersionRef = { current: 0 }
    await persistChannelManager(cm, { vssClient, cmVersionRef })

    expect(callOrder).toEqual(['vss', 'idb'])
  })

  it('uses the correct VSS key "channel_manager"', async () => {
    const vssClient = makeVssClient()
    const cmVersionRef = { current: 0 }
    const cm = makeCm()

    await persistChannelManager(cm, { vssClient, cmVersionRef })

    expect(vssClient.putObject).toHaveBeenCalledWith('channel_manager', expect.any(Uint8Array), 0)
  })

  it('tracks version across multiple writes', async () => {
    const vssClient = makeVssClient({
      putObject: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
    })
    const cmVersionRef = { current: 0 }
    const cm = makeCm()

    await persistChannelManager(cm, { vssClient, cmVersionRef })
    expect(cmVersionRef.current).toBe(1)

    await persistChannelManager(cm, { vssClient, cmVersionRef })
    expect(cmVersionRef.current).toBe(2)
    expect(vssClient.putObject).toHaveBeenNthCalledWith(
      2,
      'channel_manager',
      expect.any(Uint8Array),
      1
    )
  })

  it('throws on VSS failure (caller handles retry)', async () => {
    const vssClient = makeVssClient({
      putObject: vi.fn().mockRejectedValue(new Error('network error')),
    })
    const cmVersionRef = { current: 0 }
    const cm = makeCm()

    await expect(persistChannelManager(cm, { vssClient, cmVersionRef })).rejects.toThrow(
      'network error'
    )

    // IDB should NOT have been called (VSS failed first)
    expect(idbPut).not.toHaveBeenCalled()
  })

  it('throws on IDB failure after VSS success', async () => {
    const vssClient = makeVssClient()
    const cmVersionRef = { current: 0 }
    vi.mocked(idbPut).mockRejectedValueOnce(new Error('IDB error'))

    const cm = makeCm()
    await expect(persistChannelManager(cm, { vssClient, cmVersionRef })).rejects.toThrow(
      'IDB error'
    )

    // VSS version should still have been updated
    expect(cmVersionRef.current).toBe(1)
  })

  it('skips VSS when vssClient is null', async () => {
    const cm = makeCm()
    await persistChannelManager(cm, { vssClient: null })

    expect(idbPut).toHaveBeenCalledTimes(1)
  })

  it('skips VSS when cmVersionRef is missing', async () => {
    const vssClient = makeVssClient()
    const cm = makeCm()

    await persistChannelManager(cm, { vssClient })

    // VSS should be skipped because no version ref
    expect(vssClient.putObject).not.toHaveBeenCalled()
    expect(idbPut).toHaveBeenCalledTimes(1)
  })

  it('resolves version conflict by re-fetching server version', async () => {
    const conflictError = new VssError('conflict', ErrorCode.CONFLICT_EXCEPTION, 409)
    const vssClient = makeVssClient({
      putObject: vi
        .fn()
        .mockRejectedValueOnce(conflictError) // first attempt: conflict
        .mockResolvedValueOnce(6), // retry with corrected version succeeds
      getObject: vi.fn().mockResolvedValue({ value: new Uint8Array([1]), version: 5 }),
    })
    const cmVersionRef = { current: 0 }
    const cm = makeCm()

    await persistChannelManager(cm, { vssClient, cmVersionRef })

    expect(vssClient.getObject).toHaveBeenCalledWith('channel_manager')
    expect(vssClient.putObject).toHaveBeenCalledTimes(2)
    expect(vssClient.putObject).toHaveBeenNthCalledWith(
      2,
      'channel_manager',
      expect.any(Uint8Array),
      5
    )
    expect(cmVersionRef.current).toBe(6)
    expect(idbPut).toHaveBeenCalled()
  })

  it('resets version to 0 when getObject returns null during conflict', async () => {
    const conflictError = new VssError('conflict', ErrorCode.CONFLICT_EXCEPTION, 409)
    const vssClient = makeVssClient({
      putObject: vi.fn().mockRejectedValueOnce(conflictError).mockResolvedValueOnce(1),
      getObject: vi.fn().mockResolvedValue(null),
    })
    const cmVersionRef = { current: 3 }
    const cm = makeCm()

    await persistChannelManager(cm, { vssClient, cmVersionRef })

    expect(vssClient.putObject).toHaveBeenNthCalledWith(
      2,
      'channel_manager',
      expect.any(Uint8Array),
      0
    )
    expect(cmVersionRef.current).toBe(1)
  })

  it('throws VssConflictDuringTakeoverError when 409 hits inside grace window', async () => {
    const conflictError = new VssError('conflict', ErrorCode.CONFLICT_EXCEPTION, 409)
    const putObject = vi.fn().mockRejectedValueOnce(conflictError).mockResolvedValue(99) // would succeed if we DID retry — must NOT be called
    const vssClient = makeVssClient({
      putObject,
      getObject: vi.fn().mockResolvedValue({ value: new Uint8Array([1]), version: 7 }),
    })
    const cmVersionRef = { current: 0 }
    const cm = makeCm()

    // Simulate "lock acquired 100ms ago" — well within the 1s grace window
    await expect(
      persistChannelManager(cm, {
        vssClient,
        cmVersionRef,
        walletLockAcquiredAtOverride: Date.now() - 100,
      })
    ).rejects.toBeInstanceOf(VssConflictDuringTakeoverError)

    // versionRef MUST be updated so the caller's mustRetry latch uses the
    // server version on the next attempt
    expect(cmVersionRef.current).toBe(7)
    // No retry: putObject called exactly once
    expect(putObject).toHaveBeenCalledTimes(1)
    // No IDB write — VSS step did not complete
    expect(idbPut).not.toHaveBeenCalled()
  })

  it('retries past the takeover-grace window (genuine version drift)', async () => {
    const conflictError = new VssError('conflict', ErrorCode.CONFLICT_EXCEPTION, 409)
    const vssClient = makeVssClient({
      putObject: vi.fn().mockRejectedValueOnce(conflictError).mockResolvedValueOnce(8),
      getObject: vi.fn().mockResolvedValue({ value: new Uint8Array([1]), version: 7 }),
    })
    const cmVersionRef = { current: 0 }
    const cm = makeCm()

    // Simulate "lock acquired 5s ago" — past the 1s grace window
    await persistChannelManager(cm, {
      vssClient,
      cmVersionRef,
      walletLockAcquiredAtOverride: Date.now() - 5_000,
    })

    expect(vssClient.putObject).toHaveBeenCalledTimes(2)
    expect(cmVersionRef.current).toBe(8)
    expect(idbPut).toHaveBeenCalled()
  })

  it('retries when no wallet-lock timestamp is provided (test/non-locked context)', async () => {
    const conflictError = new VssError('conflict', ErrorCode.CONFLICT_EXCEPTION, 409)
    const vssClient = makeVssClient({
      putObject: vi.fn().mockRejectedValueOnce(conflictError).mockResolvedValueOnce(8),
      getObject: vi.fn().mockResolvedValue({ value: new Uint8Array([1]), version: 7 }),
    })
    const cmVersionRef = { current: 0 }
    const cm = makeCm()

    // No override and the production global default is null → grace check skipped
    await persistChannelManager(cm, { vssClient, cmVersionRef })

    expect(vssClient.putObject).toHaveBeenCalledTimes(2)
    expect(cmVersionRef.current).toBe(8)
  })

  it('throws non-conflict VSS errors without retry', async () => {
    const vssClient = makeVssClient({
      putObject: vi.fn().mockRejectedValue(new Error('network error')),
    })
    const cmVersionRef = { current: 0 }
    const cm = makeCm()

    await expect(persistChannelManager(cm, { vssClient, cmVersionRef })).rejects.toThrow(
      'network error'
    )

    expect(idbPut).not.toHaveBeenCalled()
    // getObject should NOT be called for non-conflict errors
    expect(vssClient.getObject).not.toHaveBeenCalled()
  })
})

describe('createChannelManagerPersistScheduler', () => {
  beforeEach(() => {
    vi.mocked(idbPut).mockReset().mockResolvedValue(undefined)
  })

  it('serializes concurrent schedules and coalesces a trailing persist', async () => {
    const firstWrite = deferred()
    let serverVersion = 0
    let callCount = 0
    const vssClient = makeVssClient({
      putObject: vi.fn().mockImplementation(async (_key, _data, expectedVersion: number) => {
        expect(expectedVersion).toBe(serverVersion)
        callCount += 1
        if (callCount === 1) await firstWrite.promise
        serverVersion += 1
        return serverVersion
      }),
    })
    const cmVersionRef = { current: 0 }
    const cm = makeDirtyCm()
    const scheduler = createChannelManagerPersistScheduler(cm as never, {
      vssClient,
      cmVersionRef,
    })

    cm.setDirty()
    const first = scheduler.schedule()
    cm.setDirty()
    const second = scheduler.schedule()
    cm.setDirty()
    const third = scheduler.schedule()

    expect(vssClient.putObject).toHaveBeenCalledTimes(1)

    firstWrite.resolve()
    await Promise.all([first, second, third])

    expect(vssClient.putObject).toHaveBeenCalledTimes(2)
    expect(cmVersionRef.current).toBe(2)
    expect(idbPut).toHaveBeenCalledTimes(2)
  })

  it('returns immediately when LDK reports clean and no prior failure', async () => {
    const vssClient = makeVssClient()
    const cm = makeDirtyCm() // never setDirty()
    const scheduler = createChannelManagerPersistScheduler(cm as never, {
      vssClient,
      cmVersionRef: { current: 0 },
    })

    await scheduler.schedule()

    expect(vssClient.putObject).not.toHaveBeenCalled()
    expect(idbPut).not.toHaveBeenCalled()
  })

  it('latches mustRetry on failure so the next schedule() retries even when LDK is clean', async () => {
    const putObject = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce(1)
    const vssClient = makeVssClient({ putObject })
    const cmVersionRef = { current: 0 }
    const cm = makeDirtyCm()
    const scheduler = createChannelManagerPersistScheduler(cm as never, {
      vssClient,
      cmVersionRef,
    })

    cm.setDirty()
    await expect(scheduler.schedule()).rejects.toThrow('transient')
    expect(putObject).toHaveBeenCalledTimes(1)

    // LDK is now reporting clean (we consumed the dirty bit on the failed
    // attempt). Without the mustRetry latch, this call would no-op and the
    // mutation would be silently lost. With the latch, the scheduler retries.
    await scheduler.schedule()
    expect(putObject).toHaveBeenCalledTimes(2)
    expect(cmVersionRef.current).toBe(1)
  })

  it('does not stay wedged after a rejection — fresh dirty signal still triggers persist', async () => {
    const putObject = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
    const vssClient = makeVssClient({ putObject })
    const cm = makeDirtyCm()
    const scheduler = createChannelManagerPersistScheduler(cm as never, {
      vssClient,
      cmVersionRef: { current: 0 },
    })

    cm.setDirty()
    await expect(scheduler.schedule()).rejects.toThrow('transient')
    await scheduler.schedule() // mustRetry-driven recovery
    cm.setDirty()
    await scheduler.schedule() // fresh dirty bit triggers a third persist

    expect(putObject).toHaveBeenCalledTimes(3)
  })

  it('cancel() suppresses trailing iterations and turns subsequent schedule() into no-ops', async () => {
    const firstWrite = deferred()
    let callCount = 0
    const putObject = vi.fn().mockImplementation(async (_k, _d, version: number) => {
      callCount += 1
      if (callCount === 1) await firstWrite.promise
      return version + 1
    })
    const vssClient = makeVssClient({ putObject })
    const cm = makeDirtyCm()
    const scheduler = createChannelManagerPersistScheduler(cm as never, {
      vssClient,
      cmVersionRef: { current: 0 },
    })

    cm.setDirty()
    const inFlight = scheduler.schedule()
    cm.setDirty()
    const followUp = scheduler.schedule() // sets pendingDirty for trailing iteration

    scheduler.cancel()
    firstWrite.resolve()
    await Promise.all([inFlight, followUp])

    // Only the in-flight iteration ran; cancel() suppressed the trailing one.
    expect(putObject).toHaveBeenCalledTimes(1)

    // After cancel, schedule() is a no-op even with fresh dirty bits.
    cm.setDirty()
    await scheduler.schedule()
    expect(putObject).toHaveBeenCalledTimes(1)
  })
})

describe('persistChannelManagerIdbOnly', () => {
  beforeEach(() => {
    vi.mocked(idbPut).mockReset().mockResolvedValue(undefined)
  })

  it('writes only to IDB', async () => {
    const cm = makeCm(new Uint8Array([5, 6, 7]))
    await persistChannelManagerIdbOnly(cm)

    expect(idbPut).toHaveBeenCalledWith('ldk_channel_manager', 'primary', new Uint8Array([5, 6, 7]))
  })
})
