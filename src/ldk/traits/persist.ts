import {
  Persist,
  ChannelMonitorUpdateStatus,
  type OutPoint,
  type ChannelMonitor,
  type ChannelMonitorUpdate,
  type ChainMonitor,
} from 'lightningdevkit'
import { idbPut, idbDelete } from '../storage/idb'
import { bytesToHex } from '../utils'

function outpointKey(outpoint: OutPoint): string {
  return `${bytesToHex(outpoint.get_txid())}:${outpoint.get_index().toString()}`
}

const MAX_PERSIST_RETRIES = 3
const RETRY_DELAY_MS = 500

async function persistWithRetry(
  store: 'ldk_channel_monitors',
  key: string,
  data: Uint8Array
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_PERSIST_RETRIES; attempt++) {
    try {
      await idbPut(store, key, data)
      return
    } catch (err: unknown) {
      console.error(
        `[LDK Persist] Write attempt ${attempt}/${MAX_PERSIST_RETRIES} failed:`,
        err
      )
      if (attempt < MAX_PERSIST_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt))
      }
    }
  }
  throw new Error(`[LDK Persist] Failed to persist after ${MAX_PERSIST_RETRIES} attempts`)
}

export interface PersistError {
  key: string
  error: Error
}

export function createPersister(): {
  persist: Persist
  setChainMonitor: (cm: ChainMonitor) => void
  onPersistFailure: (handler: (err: PersistError) => void) => void
} {
  let chainMonitorRef: ChainMonitor | null = null
  let failureHandler: ((err: PersistError) => void) | null = null

  function handlePersist(
    channel_funding_outpoint: OutPoint,
    monitor: ChannelMonitor
  ): void {
    const key = outpointKey(channel_funding_outpoint)
    const data = monitor.write()
    const updateId = monitor.get_latest_update_id()

    persistWithRetry('ldk_channel_monitors', key, data)
      .then(() => {
        if (chainMonitorRef) {
          chainMonitorRef.channel_monitor_updated(channel_funding_outpoint, updateId)
        }
      })
      .catch((err: unknown) => {
        // Do NOT call channel_monitor_updated — LDK will halt channel operations (safe)
        const error = err instanceof Error ? err : new Error(String(err))
        console.error(`[LDK Persist] CRITICAL: Monitor persistence failed for ${key}:`, error)
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
      // LDK calls this "archive" but we delete — no need to retain closed channel monitors
      const key = outpointKey(channel_funding_outpoint)
      idbDelete('ldk_channel_monitors', key).catch((err: unknown) => {
        console.error('[LDK Persist] Failed to delete archived channel monitor:', err)
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
  }
}
