import { describe, it, expect, vi } from 'vitest'
import { createSerialPersister } from './serial-persister'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('createSerialPersister', () => {
  it('runs nothing when hasPendingWork returns false on entry', async () => {
    const doPersist = vi.fn().mockResolvedValue(undefined)
    const persister = createSerialPersister(doPersist, () => false)

    await persister.schedule()

    expect(doPersist).not.toHaveBeenCalled()
  })

  it('runs once when hasPendingWork returns true on entry', async () => {
    const doPersist = vi.fn().mockResolvedValue(undefined)
    let dirty = true
    const persister = createSerialPersister(doPersist, () => {
      const wasDirty = dirty
      dirty = false
      return wasDirty
    })

    await persister.schedule()

    expect(doPersist).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent schedules into one leading + one trailing run', async () => {
    const firstWrite = deferred()
    let callCount = 0
    const doPersist = vi.fn().mockImplementation(async () => {
      callCount += 1
      if (callCount === 1) await firstWrite.promise
    })
    let dirty = false
    const persister = createSerialPersister(doPersist, () => {
      const wasDirty = dirty
      dirty = false
      return wasDirty
    })

    dirty = true
    const first = persister.schedule()
    dirty = true
    const second = persister.schedule()
    dirty = true
    const third = persister.schedule()

    expect(doPersist).toHaveBeenCalledTimes(1)
    firstWrite.resolve()
    await Promise.all([first, second, third])

    // Three external calls collapsed into 1 leading + 1 trailing
    expect(doPersist).toHaveBeenCalledTimes(2)
  })

  it('latches mustRetry on failure so the next schedule retries even when no signal', async () => {
    const doPersist = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(undefined)
    let signalled = true
    const persister = createSerialPersister(doPersist, () => {
      const wasSignalled = signalled
      signalled = false
      return wasSignalled
    })

    await expect(persister.schedule()).rejects.toThrow('transient')
    expect(doPersist).toHaveBeenCalledTimes(1)

    // No fresh signal — but mustRetry must still trigger a fresh attempt
    await persister.schedule()
    expect(doPersist).toHaveBeenCalledTimes(2)
  })

  it('cancel() suppresses trailing iterations and turns subsequent schedule() into no-ops', async () => {
    const firstWrite = deferred()
    let callCount = 0
    const doPersist = vi.fn().mockImplementation(async () => {
      callCount += 1
      if (callCount === 1) await firstWrite.promise
    })
    let dirty = false
    const persister = createSerialPersister(doPersist, () => {
      const wasDirty = dirty
      dirty = false
      return wasDirty
    })

    dirty = true
    const inFlight = persister.schedule()
    dirty = true
    const followUp = persister.schedule()

    persister.cancel()
    firstWrite.resolve()
    await Promise.all([inFlight, followUp])

    // Only the in-flight ran; trailing was cancelled
    expect(doPersist).toHaveBeenCalledTimes(1)

    dirty = true
    await persister.schedule()
    expect(doPersist).toHaveBeenCalledTimes(1)
  })

  it('default hasPendingWork (no arg) treats every schedule call as work', async () => {
    const doPersist = vi.fn().mockResolvedValue(undefined)
    const persister = createSerialPersister(doPersist)

    await persister.schedule()
    await persister.schedule()

    expect(doPersist).toHaveBeenCalledTimes(2)
  })
})
