import { describe, expect, it, vi } from 'vitest'
import { createStableEventGate } from './event-gate'

describe('durable financial event gate', () => {
  it('withholds acknowledgement until persistence completes and calls the writer once', async () => {
    let resolve!: () => void
    const save = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
    const ready = createStableEventGate(vi.fn())
    expect(ready('payment', save)).toBe(false)
    expect(ready('payment', save)).toBe(false)
    expect(save).toHaveBeenCalledTimes(1)
    resolve()
    await Promise.resolve()
    expect(ready('payment', save)).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)
  })
  it('keeps a failed write replayable', async () => {
    const error = vi.fn()
    const ready = createStableEventGate(error)
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('backup failed'))
      .mockResolvedValue(undefined)
    expect(ready('payment', save)).toBe(false)
    await Promise.resolve()
    expect(error).toHaveBeenCalledTimes(1)
    expect(ready('payment', save)).toBe(false)
    await Promise.resolve()
    expect(ready('payment', save)).toBe(true)
    expect(save).toHaveBeenCalledTimes(2)
  })
  it('does not delay unrelated events', () => {
    expect(createStableEventGate(vi.fn())('ordinary-payment', () => undefined)).toBe(true)
  })
})
