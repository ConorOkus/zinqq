import {
  Persist,
  ChannelMonitorUpdateStatus,
  type OutPoint,
  type ChannelMonitor,
  type ChannelMonitorUpdate,
  type ChainMonitor,
} from 'lightningdevkit'
import { idbPut, idbDelete } from '../../storage/idb'
import { bytesToHex } from '../utils'
import { isVssConflict, type VssClient } from '../storage/vss-client'
import { captureError } from '../../storage/error-log'

function outpointKey(outpoint: OutPoint): string {
  return `${bytesToHex(outpoint.get_txid())}:${outpoint.get_index().toString()}`
}

export const MONITOR_MANIFEST_KEY = '_monitor_keys'

const MONITOR_KEY_PATTERN = /^[0-9a-f]{64}:\d+$/
const MAX_MANIFEST_ENTRIES = 1_000

/** Parse and validate a monitor manifest from VSS. Throws on invalid data. */
export function parseMonitorManifest(json: string): string[] {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Monitor manifest is not a non-empty array')
  }
  if (parsed.length > MAX_MANIFEST_ENTRIES) {
    throw new Error(
      `Monitor manifest has ${parsed.length} entries, exceeds max of ${MAX_MANIFEST_ENTRIES}`
    )
  }
  const seen = new Set<string>()
  for (const entry of parsed) {
    if (typeof entry !== 'string' || !MONITOR_KEY_PATTERN.test(entry)) {
      throw new Error(`Invalid monitor key in manifest: ${String(entry).slice(0, 80)}`)
    }
    seen.add(entry)
  }
  return [...seen]
}

const INITIAL_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 60_000
const DEGRADED_THRESHOLD_MS = 10_000
const MAX_CONFLICT_RETRIES = 5

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export interface PersistError {
  key: string
  error: Error
}

export interface PersisterOptions {
  vssClient?: VssClient | null
  onVssUnavailable?: () => void
  onVssRecovered?: () => void
  initialMonitorKeys?: string[]
}

export function createPersister(options: PersisterOptions = {}): {
  persist: Persist
  setChainMonitor: (cm: ChainMonitor) => void
  onPersistFailure: (handler: (err: PersistError) => void) => void
  backfillManifest: () => void
  versionCache: Map<string, number>
} {
  const vssClient = options.vssClient ?? null
  const onVssUnavailable = options.onVssUnavailable ?? null
  const onVssRecovered = options.onVssRecovered ?? null

  let chainMonitorRef: ChainMonitor | null = null
  let failureHandler: ((err: PersistError) => void) | null = null
  const versionCache = new Map<string, number>()
  const monitorKeys = new Set<string>(options.initialMonitorKeys)

  // Serialize manifest writes so each one reads the correct version after the previous completes.
  let manifestWriteChain: Promise<void> = Promise.resolve()

  function writeManifest(): void {
    if (!vssClient) return
    const client = vssClient
    manifestWriteChain = manifestWriteChain.then(async () => {
      const manifest = new TextEncoder().encode(JSON.stringify([...monitorKeys]))
      const version = versionCache.get(MONITOR_MANIFEST_KEY) ?? 0
      try {
        const newVersion = await client.putObject(MONITOR_MANIFEST_KEY, manifest, version)
        versionCache.set(MONITOR_MANIFEST_KEY, newVersion)
      } catch (err: unknown) {
        if (isVssConflict(err)) {
          // Re-fetch server version, merge server keys into local set, then retry once
          try {
            const serverObj = await client.getObject(MONITOR_MANIFEST_KEY)
            if (serverObj) {
              versionCache.set(MONITOR_MANIFEST_KEY, serverObj.version)
              // Merge server keys so we never drop a monitor tracked by another device
              try {
                const serverKeys = parseMonitorManifest(new TextDecoder().decode(serverObj.value))
                for (const k of serverKeys) monitorKeys.add(k)
              } catch (e) {
                captureError(
                  'warning',
                  'LDK Persist',
                  'Server manifest parse failed, overwriting with local keys',
                  String(e)
                )
              }
              const merged = new TextEncoder().encode(JSON.stringify([...monitorKeys]))
              const newVersion = await client.putObject(
                MONITOR_MANIFEST_KEY,
                merged,
                serverObj.version
              )
              versionCache.set(MONITOR_MANIFEST_KEY, newVersion)
              return
            }
          } catch {
            /* retry failed, fall through to warning */
          }
        }
        captureError('warning', 'LDK Persist', 'Failed to write monitor manifest', String(err))
      }
    })
  }

  /**
   * Persist monitor data to VSS (if available) then IDB with indefinite exponential backoff.
   *
   * Write ordering: VSS first (durable remote), then IDB (fast local).
   * If VSS write fails, we retry indefinitely — channel operations are halted
   * because channel_monitor_updated is never called until both writes succeed.
   */
  async function persistWithRetry(
    store: 'ldk_channel_monitors',
    key: string,
    data: Uint8Array
  ): Promise<void> {
    let backoff = INITIAL_BACKOFF_MS
    let totalWaitMs = 0
    let degradedNotified = false
    let conflictRetries = 0

    while (true) {
      try {
        // VSS first (durable remote)
        if (vssClient) {
          const version = versionCache.get(key) ?? 0
          const newVersion = await vssClient.putObject(key, data, version)
          versionCache.set(key, newVersion)
        }

        // IDB second (fast local)
        await idbPut(store, key, data)

        // If we were in a degraded state, signal recovery
        if (degradedNotified) {
          onVssRecovered?.()
        }
        return
      } catch (err: unknown) {
        // Version conflict: re-fetch server version, compare, retry (capped)
        if (vssClient && isVssConflict(err) && conflictRetries < MAX_CONFLICT_RETRIES) {
          conflictRetries++
          captureError(
            'warning',
            'LDK Persist',
            `Version conflict for ${key}, resolving (attempt ${conflictRetries}/${MAX_CONFLICT_RETRIES})...`
          )
          try {
            const serverObj = await vssClient.getObject(key)
            if (serverObj) {
              // Update local version cache to server's version
              versionCache.set(key, serverObj.version)
              // Check if server already has the same data
              if (arraysEqual(serverObj.value, data)) {
                console.log(`[LDK Persist] Conflict resolved: server has same data for ${key}`)
                await idbPut(store, key, data)
                if (degradedNotified) onVssRecovered?.()
                return
              }
              // Different data — log critical but use server version for next write attempt
              captureError(
                'critical',
                'LDK Persist',
                `True version conflict for ${key}. Server version: ${serverObj.version}. Retrying with corrected version.`
              )
            } else {
              // Key was deleted on the server — reset version to 0
              versionCache.set(key, 0)
              captureError(
                'warning',
                'LDK Persist',
                `Key ${key} not found on server during conflict resolution, resetting version to 0`
              )
            }
          } catch (resolveErr: unknown) {
            captureError(
              'error',
              'LDK Persist',
              'Failed to resolve version conflict',
              String(resolveErr)
            )
          }
          // Retry immediately with corrected version
          continue
        }

        // Conflict retries exhausted — fall through to exponential backoff.
        // Do NOT reset conflictRetries: subsequent conflicts go straight to
        // backoff (intentional — prevents infinite conflict-retry loops).
        if (vssClient && isVssConflict(err)) {
          captureError(
            'critical',
            'LDK Persist',
            `Conflict resolution exhausted for ${key} after ${MAX_CONFLICT_RETRIES} attempts, falling back to backoff`
          )
        }

        captureError('critical', 'LDK Persist', `Persist write failed for ${key}`, String(err))
        await new Promise((resolve) => setTimeout(resolve, backoff))
        totalWaitMs += backoff
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)

        if (!degradedNotified && totalWaitMs >= DEGRADED_THRESHOLD_MS) {
          degradedNotified = true
          onVssUnavailable?.()
        }
      }
    }
  }

  // Per-channel write queue: serializes writes to the same monitor so
  // concurrent updates don't race on the VSS version cache. LDK's InProgress
  // return halts further updates per channel, so queue depth is bounded at 1-2.
  const channelWriteChains = new Map<string, Promise<void>>()

  function handlePersist(channel_funding_outpoint: OutPoint, monitor: ChannelMonitor): void {
    const key = outpointKey(channel_funding_outpoint)
    const data = monitor.write()
    const updateId = monitor.get_latest_update_id()

    const prev = channelWriteChains.get(key) ?? Promise.resolve()
    const next = prev
      .catch(() => {}) // Swallow previous error so the chain continues
      .then(() => persistWithRetry('ldk_channel_monitors', key, data))
    channelWriteChains.set(key, next)

    next
      .then(() => {
        if (chainMonitorRef) {
          chainMonitorRef.channel_monitor_updated(channel_funding_outpoint, updateId)
        }
      })
      .catch((err: unknown) => {
        // Do NOT call channel_monitor_updated — LDK will halt channel operations (safe)
        const error = err instanceof Error ? err : new Error(String(err))
        captureError('critical', 'Persist', `Monitor persistence failed for ${key}`, error.message)
        if (failureHandler) {
          failureHandler({ key, error })
        }
      })
  }

  const persist = Persist.new_impl({
    persist_new_channel(
      channel_funding_outpoint: OutPoint,
      monitor: ChannelMonitor
    ): ChannelMonitorUpdateStatus {
      const key = outpointKey(channel_funding_outpoint)
      monitorKeys.add(key)
      writeManifest()
      handlePersist(channel_funding_outpoint, monitor)
      return ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_InProgress
    },

    update_persisted_channel(
      channel_funding_outpoint: OutPoint,
      _monitor_update: ChannelMonitorUpdate | null,
      monitor: ChannelMonitor
    ): ChannelMonitorUpdateStatus {
      handlePersist(channel_funding_outpoint, monitor)
      return ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_InProgress
    },

    archive_persisted_channel(channel_funding_outpoint: OutPoint): void {
      const key = outpointKey(channel_funding_outpoint)
      monitorKeys.delete(key)
      channelWriteChains.delete(key) // Clean up resolved promise reference
      writeManifest()

      // Delete from VSS first, then IDB.
      // Archive is fire-and-forget (no retry): orphaned VSS keys waste storage
      // but do not affect fund safety since the channel is already closed.
      const deleteVss = vssClient
        ? vssClient
            .deleteObject(key, versionCache.get(key) ?? 0)
            .then(() => {
              versionCache.delete(key)
            })
            .catch((err: unknown) => {
              captureError('error', 'LDK Persist', `Failed to delete ${key} from VSS`, String(err))
            })
        : Promise.resolve()

      deleteVss
        .then(() => idbDelete('ldk_channel_monitors', key))
        .catch((err: unknown) => {
          captureError(
            'error',
            'LDK Persist',
            'Failed to delete archived channel monitor',
            String(err)
          )
        })
    },
  })

  return {
    persist,
    setChainMonitor: (cm: ChainMonitor) => {
      chainMonitorRef = cm
    },
    onPersistFailure: (handler: (err: PersistError) => void) => {
      failureHandler = handler
    },
    backfillManifest: () => {
      if (monitorKeys.size > 0 && !versionCache.has(MONITOR_MANIFEST_KEY)) {
        writeManifest()
      }
    },
    versionCache,
  }
}
