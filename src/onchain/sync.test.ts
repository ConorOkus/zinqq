import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startOnchainSyncLoop } from './sync'

// Mock config — short interval for fast tests
vi.mock('./config', () => ({
  ONCHAIN_CONFIG: { syncIntervalMs: 30_000, syncParallelRequests: 2 },
}))

// Mock storage — no-op
vi.mock('./storage/changeset', () => ({
  putChangeset: vi.fn().mockResolvedValue(undefined),
}))

// Mock error log — no-op
vi.mock('../storage/error-log', () => ({
  captureError: vi.fn(),
}))

function makeBalance(confirmed: bigint): { to_sat: () => bigint } {
  return { to_sat: () => confirmed }
}

function makeWallet() {
  return {
    balance: {
      confirmed: makeBalance(1000n),
      trusted_pending: makeBalance(0n),
      untrusted_pending: makeBalance(0n),
    },
    start_sync_with_revealed_spks: vi.fn(() => 'sync-request'),
    apply_update: vi.fn(),
    take_staged: vi.fn(() => null),
  }
}

function makeEsploraClient() {
  return {
    sync: vi.fn().mockResolvedValue('update'),
  }
}

describe('startOnchainSyncLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits initial balance immediately', () => {
    const wallet = makeWallet()
    const esplora = makeEsploraClient()
    const onUpdate = vi.fn()

    const handle = startOnchainSyncLoop(wallet as never, esplora as never, onUpdate)
    // Initial balance emitted synchronously
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate).toHaveBeenCalledWith({
      confirmed: 1000n,
      trustedPending: 0n,
      untrustedPending: 0n,
    })
    handle.stop()
  })

  it('syncNow fires an immediate sync tick', async () => {
    const wallet = makeWallet()
    const esplora = makeEsploraClient()
    const onUpdate = vi.fn()

    const handle = startOnchainSyncLoop(wallet as never, esplora as never, onUpdate)
    // Clear initial balance call
    onUpdate.mockClear()

    // Normal interval hasn't fired yet
    expect(esplora.sync).not.toHaveBeenCalled()

    // syncNow should fire immediately (not waiting for the interval)
    handle.syncNow()
    // Let the async tick resolve
    await vi.advanceTimersByTimeAsync(0)

    expect(esplora.sync).toHaveBeenCalledTimes(1)
    expect(onUpdate).toHaveBeenCalledTimes(1)

    handle.stop()
  })

  it('syncNow triggers 3 retries at 3s intervals', async () => {
    const wallet = makeWallet()
    const esplora = makeEsploraClient()
    const onUpdate = vi.fn()

    const handle = startOnchainSyncLoop(wallet as never, esplora as never, onUpdate)
    onUpdate.mockClear()
    esplora.sync.mockClear()

    // Fire syncNow — this does tick #1 immediately
    handle.syncNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(esplora.sync).toHaveBeenCalledTimes(1)

    // Retry 1: after 3s
    await vi.advanceTimersByTimeAsync(3_000)
    expect(esplora.sync).toHaveBeenCalledTimes(2)

    // Retry 2: after another 3s
    await vi.advanceTimersByTimeAsync(3_000)
    expect(esplora.sync).toHaveBeenCalledTimes(3)

    // Retry 3: after another 3s
    await vi.advanceTimersByTimeAsync(3_000)
    expect(esplora.sync).toHaveBeenCalledTimes(4)

    handle.stop()
  })

  it('resumes normal 30s interval after retries complete', async () => {
    const wallet = makeWallet()
    const esplora = makeEsploraClient()
    const onUpdate = vi.fn()

    const handle = startOnchainSyncLoop(wallet as never, esplora as never, onUpdate)
    esplora.sync.mockClear()

    // syncNow + 3 retries = 4 ticks
    handle.syncNow()
    await vi.advanceTimersByTimeAsync(0) // immediate tick
    await vi.advanceTimersByTimeAsync(3_000) // retry 1
    await vi.advanceTimersByTimeAsync(3_000) // retry 2
    await vi.advanceTimersByTimeAsync(3_000) // retry 3
    expect(esplora.sync).toHaveBeenCalledTimes(4)

    // Next tick should be at the normal 30s interval, not 3s
    await vi.advanceTimersByTimeAsync(3_000)
    expect(esplora.sync).toHaveBeenCalledTimes(4) // No extra tick at 3s

    await vi.advanceTimersByTimeAsync(27_000) // Remaining 27s to complete 30s
    expect(esplora.sync).toHaveBeenCalledTimes(5) // Normal interval tick

    handle.stop()
  })

  it('stop prevents further ticks', async () => {
    const wallet = makeWallet()
    const esplora = makeEsploraClient()
    const onUpdate = vi.fn()

    const handle = startOnchainSyncLoop(wallet as never, esplora as never, onUpdate)
    esplora.sync.mockClear()

    handle.stop()

    // Advance past the normal sync interval
    await vi.advanceTimersByTimeAsync(60_000)
    expect(esplora.sync).not.toHaveBeenCalled()
  })
})
