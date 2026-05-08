import { describe, it, expect, vi, beforeEach } from 'vitest'
import { vssWriteWithConflictRetry, VssConflictDuringTakeoverError } from './vss-write'
import { VssError, type VssClient } from './vss-client'
import { ErrorCode } from './proto/vss_pb'

/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await */

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

describe('vssWriteWithConflictRetry', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('writes and updates versionRef on success', async () => {
    const vssClient = makeVssClient({
      putObject: vi.fn().mockResolvedValue(7),
    })
    const versionRef = { current: 6 }

    await vssWriteWithConflictRetry(vssClient, 'foo', new Uint8Array([1]), versionRef)

    expect(vssClient.putObject).toHaveBeenCalledWith('foo', new Uint8Array([1]), 6)
    expect(versionRef.current).toBe(7)
  })

  it('rethrows non-conflict errors without retry', async () => {
    const vssClient = makeVssClient({
      putObject: vi.fn().mockRejectedValue(new Error('network')),
    })
    const versionRef = { current: 0 }

    await expect(
      vssWriteWithConflictRetry(vssClient, 'foo', new Uint8Array([1]), versionRef)
    ).rejects.toThrow('network')

    expect(vssClient.getObject).not.toHaveBeenCalled()
  })

  it('refetches version + retries once on 409 outside grace window', async () => {
    const conflict = new VssError('c', ErrorCode.CONFLICT_EXCEPTION, 409)
    const vssClient = makeVssClient({
      putObject: vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce(8),
      getObject: vi.fn().mockResolvedValue({ value: new Uint8Array([1]), version: 7 }),
    })
    const versionRef = { current: 0 }

    await vssWriteWithConflictRetry(vssClient, 'foo', new Uint8Array([1]), versionRef, {
      walletLockAcquiredAtOverride: Date.now() - 5_000, // past grace
    })

    expect(vssClient.putObject).toHaveBeenCalledTimes(2)
    expect(versionRef.current).toBe(8)
  })

  it('throws VssConflictDuringTakeoverError on 409 inside grace window without retry', async () => {
    const conflict = new VssError('c', ErrorCode.CONFLICT_EXCEPTION, 409)
    const putObject = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValue(99)
    const vssClient = makeVssClient({
      putObject,
      getObject: vi.fn().mockResolvedValue({ value: new Uint8Array([1]), version: 7 }),
    })
    const versionRef = { current: 0 }

    await expect(
      vssWriteWithConflictRetry(vssClient, 'foo', new Uint8Array([1]), versionRef, {
        walletLockAcquiredAtOverride: Date.now() - 100, // inside 1s grace
      })
    ).rejects.toBeInstanceOf(VssConflictDuringTakeoverError)

    // versionRef is updated so the caller's next attempt uses the corrected version
    expect(versionRef.current).toBe(7)
    // No retry
    expect(putObject).toHaveBeenCalledTimes(1)
  })

  it('refetches version 0 when getObject returns null during conflict', async () => {
    const conflict = new VssError('c', ErrorCode.CONFLICT_EXCEPTION, 409)
    const vssClient = makeVssClient({
      putObject: vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce(1),
      getObject: vi.fn().mockResolvedValue(null),
    })
    const versionRef = { current: 5 }

    await vssWriteWithConflictRetry(vssClient, 'foo', new Uint8Array([1]), versionRef, {
      walletLockAcquiredAtOverride: Date.now() - 5_000,
    })

    expect(vssClient.putObject).toHaveBeenNthCalledWith(2, 'foo', new Uint8Array([1]), 0)
    expect(versionRef.current).toBe(1)
  })

  it('treats null walletLockAcquiredAt (no lock yet) as "skip grace check" — retries normally', async () => {
    const conflict = new VssError('c', ErrorCode.CONFLICT_EXCEPTION, 409)
    const vssClient = makeVssClient({
      putObject: vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce(8),
      getObject: vi.fn().mockResolvedValue({ value: new Uint8Array([1]), version: 7 }),
    })
    const versionRef = { current: 0 }

    await vssWriteWithConflictRetry(vssClient, 'foo', new Uint8Array([1]), versionRef, {
      walletLockAcquiredAtOverride: null,
    })

    expect(vssClient.putObject).toHaveBeenCalledTimes(2)
    expect(versionRef.current).toBe(8)
  })
})
