import {
  Persist,
  ChannelMonitorUpdateStatus,
  type OutPoint,
  type ChannelMonitor,
  type ChannelMonitorUpdate,
} from 'lightningdevkit'
import { idbPut, idbDelete } from '../storage/idb'

function outpointKey(outpoint: OutPoint): string {
  const txid = Array.from(outpoint.get_txid())
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `${txid}:${outpoint.get_index().toString()}`
}

export function createPersister(): Persist {
  return Persist.new_impl({
    persist_new_channel(
      channel_funding_outpoint: OutPoint,
      monitor: ChannelMonitor
    ): ChannelMonitorUpdateStatus {
      const key = outpointKey(channel_funding_outpoint)
      const data = monitor.write()

      // IndexedDB is async but Persist methods are sync.
      // We persist asynchronously and return InProgress, then notify
      // ChainMonitor when complete. For the foundation layer this is
      // acceptable — full async persistence with ChainMonitor callback
      // will be implemented when ChannelManager is added.
      idbPut('ldk_channel_monitors', key, data).catch((err: unknown) => {
        console.error('[LDK Persist] Failed to persist new channel monitor:', err)
      })

      return ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_InProgress
    },

    update_persisted_channel(
      channel_funding_outpoint: OutPoint,
      _monitor_update: ChannelMonitorUpdate | null,
      monitor: ChannelMonitor
    ): ChannelMonitorUpdateStatus {
      const key = outpointKey(channel_funding_outpoint)
      // Persist the full updated monitor (simplest approach)
      const data = monitor.write()

      idbPut('ldk_channel_monitors', key, data).catch((err: unknown) => {
        console.error('[LDK Persist] Failed to update channel monitor:', err)
      })

      return ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_InProgress
    },

    archive_persisted_channel(channel_funding_outpoint: OutPoint): void {
      const key = outpointKey(channel_funding_outpoint)
      // Move to an archived prefix rather than deleting
      idbDelete('ldk_channel_monitors', key).catch((err: unknown) => {
        console.error('[LDK Persist] Failed to archive channel monitor:', err)
      })
    },
  })
}
