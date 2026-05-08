import type { ChannelManager } from 'lightningdevkit'
import { idbPut } from '../../storage/idb'
import { walletLockAcquiredAt } from '../init'
import { isVssConflict, type VssClient } from './vss-client'

const CM_VSS_KEY = 'channel_manager'
const CM_IDB_KEY = 'primary'

/**
 * Window after acquiring the wallet lock during which a 409 from VSS is
 * presumed to be a ghost-write from the previous active tab — its in-flight
 * `putObject` landed after our initial VSS read but before our first persist.
 * Inside this window we update `versionRef` and throw without retrying so the
 * caller's `mustRetry` latch picks up on the next tick (by which time the
 * race has resolved). Outside the window we keep the existing retry-once
 * behaviour for genuine server-side version drift.
 */
const TAKEOVER_GRACE_MS = 1_000

export interface CmPersistContext {
  vssClient?: VssClient | null
  /** Mutable ref holding the current VSS version for the ChannelManager key. */
  cmVersionRef?: { current: number }
  /**
   * Override for `walletLockAcquiredAt` — tests inject a fixed value to
   * exercise the takeover-grace branch without racing the real lock.
   */
  walletLockAcquiredAtOverride?: number | null
}

/**
 * Error thrown when a VSS conflict is observed inside the takeover-grace
 * window. Distinguishes the "former tab's ghost write" case from a generic
 * VSS error so callers can log/surface differently if they want.
 */
export class VssConflictDuringTakeoverError extends Error {
  constructor(public readonly correctedVersion: number) {
    super(
      `VSS 409 within ${TAKEOVER_GRACE_MS}ms of acquiring wallet lock — likely former tab's late write. Refusing to overwrite.`
    )
    this.name = 'VssConflictDuringTakeoverError'
  }
}

/**
 * Persist ChannelManager to VSS (if available) then IDB.
 *
 * Unlike ChannelMonitor persistence, this does NOT retry indefinitely —
 * the caller (chain-sync or event timer) is responsible for retry scheduling.
 * This function throws on non-conflict failures so the caller can set a retry flag.
 *
 * Version conflicts are resolved inline: re-fetch the server's version and retry once.
 * This handles the common case of version 0 after restart when the server has a higher version.
 */
export async function persistChannelManager(
  cm: ChannelManager,
  ctx: CmPersistContext = {}
): Promise<void> {
  const data = cm.write()
  const vssClient = ctx.vssClient ?? null
  const versionRef = ctx.cmVersionRef

  // VSS first (durable remote)
  if (vssClient && versionRef) {
    try {
      const newVersion = await vssClient.putObject(CM_VSS_KEY, data, versionRef.current)
      versionRef.current = newVersion
    } catch (err: unknown) {
      if (isVssConflict(err)) {
        // Re-fetch server version. In all cases we want versionRef updated so
        // the next attempt uses the correct expected version.
        const serverObj = await vssClient.getObject(CM_VSS_KEY)
        const correctedVersion = serverObj ? serverObj.version : 0
        versionRef.current = correctedVersion

        // Detect the takeover-window ghost-write race: a 409 within the grace
        // period after acquiring the wallet lock almost certainly came from
        // the previous active tab's in-flight putObject completing AFTER our
        // initial VSS read. Overwriting at `correctedVersion` would clobber
        // that tab's last-known state (which our in-memory CM doesn't include
        // because we loaded from VSS before its write landed).
        const acquiredAt = ctx.walletLockAcquiredAtOverride ?? walletLockAcquiredAt
        if (acquiredAt !== null && Date.now() - acquiredAt < TAKEOVER_GRACE_MS) {
          throw new VssConflictDuringTakeoverError(correctedVersion)
        }

        // Past the grace window: a 409 means the server drifted under us
        // (server-side issue) or — within a single tab — it should be
        // structurally impossible because the scheduler serialises writes.
        // The retry-once preserves existing behaviour for the drift case.
        const newVersion = await vssClient.putObject(CM_VSS_KEY, data, correctedVersion)
        versionRef.current = newVersion
      } else {
        throw err
      }
    }
  }

  // IDB second (fast local)
  await idbPut('ldk_channel_manager', CM_IDB_KEY, data)
}

export interface ChannelManagerPersistScheduler {
  /**
   * Schedule a persist. Owns LDK's dirty bit — the scheduler calls
   * `get_and_clear_needs_persistence()` itself, so callers should NOT gate
   * on it. Calling `schedule()` repeatedly is cheap when nothing is dirty.
   *
   * Returns a promise that settles when the run satisfying this call
   * completes. If the persist throws, all coalesced waiters reject; the
   * scheduler latches `mustRetry` so the next `schedule()` will retry even
   * if LDK now reports clean.
   */
  schedule: () => Promise<void>
  /**
   * Suppress further iterations. An in-flight VSS write is allowed to
   * complete (we cannot safely abort mid-flight), but no trailing iteration
   * runs and subsequent `schedule()` calls become no-ops. Used in teardown
   * to keep this tab's scheduler from clobbering a new tab after takeover.
   */
  cancel: () => void
}

export function createChannelManagerPersistScheduler(
  cm: ChannelManager,
  ctx: CmPersistContext = {}
): ChannelManagerPersistScheduler {
  let inFlight: Promise<void> | null = null
  let pendingDirty = false
  let mustRetry = false
  let cancelled = false

  function schedule(): Promise<void> {
    if (cancelled) return Promise.resolve()

    // Single owner of LDK's dirty bit — never cleared without a corresponding
    // persist attempt landing (or being latched in mustRetry on failure).
    if (cm.get_and_clear_needs_persistence()) {
      pendingDirty = true
    }

    if (!pendingDirty && !mustRetry) {
      return inFlight ?? Promise.resolve()
    }

    if (inFlight) return inFlight

    inFlight = (async () => {
      while (!cancelled) {
        // Fold any LDK dirty signal that arrived since the last iteration
        // started. Without this, an event firing during the await would set
        // LDK's dirty bit but neither pendingDirty nor mustRetry — and the
        // mutation would silently miss this drain.
        if (cm.get_and_clear_needs_persistence()) pendingDirty = true
        if (!pendingDirty && !mustRetry) break

        pendingDirty = false
        mustRetry = false
        try {
          await persistChannelManager(cm, ctx)
        } catch (err) {
          // The dirty bit was already consumed for this iteration; latch
          // mustRetry so the next schedule() picks up the work even when
          // LDK now reports clean. Surface the error to the awaiter — the
          // next chain-sync tick or event-drain re-enters the scheduler.
          mustRetry = true
          throw err
        }
      }
    })().finally(() => {
      inFlight = null
    })

    return inFlight
  }

  return {
    schedule,
    cancel: () => {
      cancelled = true
    },
  }
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
