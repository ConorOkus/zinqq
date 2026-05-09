import type { ChannelManager } from 'lightningdevkit'
import { idbPut } from '../../storage/idb'
import { createSerialPersister, type SerialPersister } from './serial-persister'
import { vssWriteWithConflictRetry, type VssWriteOptions } from './vss-write'
import type { VssClient } from './vss-client'

const CM_VSS_KEY = 'channel_manager'
const CM_IDB_KEY = 'primary'

export { VssConflictDuringTakeoverError } from './vss-write'

export interface CmPersistContext extends VssWriteOptions {
  vssClient?: VssClient | null
  /** Mutable ref holding the current VSS version for the ChannelManager key. */
  cmVersionRef?: { current: number }
}

/**
 * Persist ChannelManager to VSS (if available) then IDB.
 *
 * Unlike ChannelMonitor persistence, this does NOT retry indefinitely —
 * the caller (chain-sync or event timer) is responsible for retry scheduling.
 * Throws on non-conflict failures so the caller can set a retry flag.
 *
 * Conflict handling lives in `vssWriteWithConflictRetry`, which honours the
 * wallet-lock takeover-grace window: a 409 within the grace period throws
 * `VssConflictDuringTakeoverError` instead of overwriting (would clobber the
 * previous active tab's late write). Outside the grace, retry-once handles
 * genuine server-side version drift.
 */
export async function persistChannelManager(
  cm: ChannelManager,
  ctx: CmPersistContext = {}
): Promise<void> {
  const data = cm.write()
  const vssClient = ctx.vssClient ?? null
  const versionRef = ctx.cmVersionRef

  if (vssClient && versionRef) {
    await vssWriteWithConflictRetry(vssClient, CM_VSS_KEY, data, versionRef, {
      walletLockAcquiredAtOverride: ctx.walletLockAcquiredAtOverride,
    })
  }

  await idbPut('ldk_channel_manager', CM_IDB_KEY, data)
}

export type ChannelManagerPersistScheduler = SerialPersister

/**
 * One scheduler instance per ChannelManager — structurally enforced via
 * WeakMap. Without this, React StrictMode's double-effect or HMR's
 * fast-refresh could produce two schedulers for the same CM, each with
 * independent `inFlight`/`pendingDirty` state, defeating serialisation
 * and reintroducing the 409-storm bug PR #157 fixed. See todo #341.
 *
 * `WeakMap` ensures the cached scheduler is GC-eligible when the CM
 * itself is dropped — no manual cleanup needed.
 */
const SCHEDULERS_BY_CM = new WeakMap<ChannelManager, ChannelManagerPersistScheduler>()

/**
 * Wrap `persistChannelManager` in a single-flight scheduler that owns LDK's
 * dirty bit. Callers invoke `schedule()` unconditionally; the scheduler
 * consults `cm.get_and_clear_needs_persistence()` and skips when clean.
 *
 * Idempotent per ChannelManager: repeated calls with the same `cm` return
 * the same scheduler (so two LdkProvider effect runs share state instead
 * of racing with each other). The `ctx` from the first call is used; later
 * `ctx` arguments are ignored — pass the same VSS client/version ref each
 * time, or rely on the closure capturing the original.
 */
export function createChannelManagerPersistScheduler(
  cm: ChannelManager,
  ctx: CmPersistContext = {}
): ChannelManagerPersistScheduler {
  const existing = SCHEDULERS_BY_CM.get(cm)
  if (existing) return existing

  const scheduler = createSerialPersister(
    () => persistChannelManager(cm, ctx),
    () => cm.get_and_clear_needs_persistence()
  )
  SCHEDULERS_BY_CM.set(cm, scheduler)
  return scheduler
}

/**
 * Best-effort IDB-only persist for the visibility change handler.
 *
 * The browser may kill the tab before a network request completes,
 * so this path skips VSS entirely.
 */
export function persistChannelManagerIdbOnly(cm: ChannelManager): Promise<void> {
  return idbPut('ldk_channel_manager', CM_IDB_KEY, cm.write())
}
