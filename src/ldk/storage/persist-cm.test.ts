import { describe, it, expect, vi, beforeEach } from 'vitest'
import { persistChannelManager, persistChannelManagerIdbOnly } from './persist-cm'
import { VssError, type VssClient } from './vss-client'
import { ErrorCode } from './proto/vss_pb'

vi.mock('../../storage/idb', () => ({
  idbPut: vi.fn().mockResolvedValue(undefined),
}))

import { idbPut } from '../../storage/idb'

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/unbound-method, @typescript-eslint/require-await */

function makeCm(data = new Uint8Array([1, 2, 3])) {
  return { write: vi.fn(() => data) } as never
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
